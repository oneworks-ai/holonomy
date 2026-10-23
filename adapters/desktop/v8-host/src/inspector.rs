//! Owner-private CDP transport for the one Guest V8 context.
//!
//! The Unix socket carries bounded owned JSON frames. V8 Inspector, including
//! its paused message loop, is always dispatched on the Guest isolate thread.
//! No Host or module-planner context is registered with this Inspector.

use crate::state::HostState;
use sha2::{Digest, Sha256};
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    fs,
    io::{Read, Write},
    os::fd::AsRawFd,
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    rc::{Rc, Weak},
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
use v8::inspector::{
    Channel, ChannelImpl, StringBuffer, StringView, V8Inspector, V8InspectorClient,
    V8InspectorClientImpl, V8InspectorClientTrustLevel, V8InspectorSession,
};

const MAX_INBOUND: usize = 64 * 1024;
const MAX_OUTBOUND: usize = 1024 * 1024;
const MAX_PENDING: usize = 32;
const GUEST_GROUP: i32 = 1;

struct Io {
    listener: UnixListener,
    path: PathBuf,
    device: u64,
    inode: u64,
    stream: Option<UnixStream>,
    input: Vec<u8>,
    output: VecDeque<(Vec<u8>, usize)>,
    output_bytes: usize,
    accepted: bool,
    closed: bool,
    guest_context_id: Option<i64>,
}

impl Io {
    fn close(&mut self) {
        self.closed = true;
        self.stream.take();
        self.input.clear();
        self.output.clear();
        self.output_bytes = 0;
    }
    fn bind(path: &Path) -> Result<Self, String> {
        let parent = path.parent().ok_or("Inspector socket has no parent")?;
        let canonical = parent
            .canonicalize()
            .map_err(|_| "Inspector socket parent is unavailable")?;
        if path.file_name().is_none() || path.as_os_str().len() > 100 {
            return Err("Inspector socket path is invalid".into());
        }
        let metadata = fs::symlink_metadata(&canonical)
            .map_err(|_| "Inspector socket parent is unavailable")?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err("Inspector socket parent must be owner-private".into());
        }
        for ancestor in canonical.ancestors() {
            let metadata =
                fs::symlink_metadata(ancestor).map_err(|_| "Inspector parent is unavailable")?;
            if !metadata.is_dir()
                || metadata.is_symlink()
                || (metadata.uid() != 0 && metadata.uid() != unsafe { libc::geteuid() })
                || (metadata.mode() & 0o022 != 0 && metadata.mode() & 0o1000 == 0)
            {
                return Err("Inspector socket ancestors are not trusted".into());
            }
        }
        let path = canonical.join(path.file_name().ok_or("Invalid Inspector socket name")?);
        if path.as_os_str().len() > 100 {
            return Err("Inspector socket path is too long".into());
        }
        if fs::symlink_metadata(&path).is_ok() {
            return Err("Inspector socket path already exists".into());
        }
        let listener = UnixListener::bind(&path).map_err(|_| "Inspector socket bind failed")?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "Inspector socket permission install failed")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Inspector socket setup failed")?;
        let socket = fs::symlink_metadata(&path).map_err(|_| "Inspector socket setup failed")?;
        Ok(Self {
            listener,
            path,
            device: socket.dev(),
            inode: socket.ino(),
            stream: None,
            input: Vec::new(),
            output: VecDeque::new(),
            output_bytes: 0,
            accepted: false,
            closed: false,
            guest_context_id: None,
        })
    }

    fn accept(&mut self) -> bool {
        if self.accepted || self.closed {
            return false;
        }
        match self.listener.accept() {
            Ok((stream, _)) => {
                if !peer_is_owner(&stream) {
                    return false;
                }
                if stream.set_nonblocking(true).is_err() {
                    self.closed = true;
                    return false;
                }
                self.stream = Some(stream);
                self.accepted = true;
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => false,
            Err(_) => {
                self.closed = true;
                false
            }
        }
    }

    fn receive(&mut self) -> Option<String> {
        if self.closed {
            return None;
        }
        let stream = self.stream.as_mut()?;
        let mut buf = [0u8; 4096];
        loop {
            match stream.read(&mut buf) {
                Ok(0) => {
                    self.closed = true;
                    break;
                }
                Ok(count) => {
                    self.input.extend_from_slice(&buf[..count]);
                    if self.input.len() > MAX_INBOUND {
                        self.closed = true;
                        break;
                    }
                    if self.input.contains(&b'\n') {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.closed = true;
                    break;
                }
            }
        }
        if self.closed {
            self.close();
            return None;
        }
        let end = self.input.iter().position(|byte| *byte == b'\n')?;
        let bytes = self.input.drain(..=end).collect::<Vec<_>>();
        String::from_utf8(bytes[..end].to_vec()).ok()
    }

    fn enqueue(&mut self, message: String) {
        if self.closed || !self.accepted {
            return;
        }
        let bytes = message.into_bytes();
        if bytes.len() > MAX_OUTBOUND
            || self.output.len() >= MAX_PENDING
            || self.output_bytes.saturating_add(bytes.len() + 1) > MAX_OUTBOUND
        {
            self.close();
            return;
        }
        self.output_bytes += bytes.len() + 1;
        let mut frame = bytes;
        frame.push(b'\n');
        self.output.push_back((frame, 0));
    }

    fn flush(&mut self) {
        let Some(stream) = self.stream.as_mut() else {
            return;
        };
        while let Some((frame, sent)) = self.output.front_mut() {
            match stream.write(&frame[*sent..]) {
                Ok(0) => {
                    self.closed = true;
                    break;
                }
                Ok(count) => {
                    *sent += count;
                    if *sent == frame.len() {
                        self.output_bytes -= frame.len();
                        self.output.pop_front();
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    self.closed = true;
                    break;
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn peer_is_owner(stream: &UnixStream) -> bool {
    let mut uid = 0;
    let mut gid = 0;
    unsafe {
        libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) == 0 && uid == libc::geteuid()
    }
}

#[cfg(target_os = "linux")]
fn peer_is_owner(stream: &UnixStream) -> bool {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut credentials as *mut _ as *mut libc::c_void,
            &mut length,
        ) == 0
            && credentials.uid == libc::geteuid()
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn peer_is_owner(_stream: &UnixStream) -> bool {
    false
}

impl Drop for Io {
    fn drop(&mut self) {
        if fs::symlink_metadata(&self.path)
            .is_ok_and(|meta| meta.dev() == self.device && meta.ino() == self.inode)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

struct Output(Rc<RefCell<Io>>);

fn bounded_protocol_text(view: StringView<'_>) -> Option<String> {
    // Bound before allocating a Rust UTF-8 copy; the exact wire limit is then
    // checked after conversion. V8's own serialization has separate allocations.
    if view.len() > MAX_OUTBOUND {
        return None;
    }
    let text = view.to_string();
    (text.len() <= MAX_OUTBOUND).then_some(text)
}

impl ChannelImpl for Output {
    fn send_response(&self, _id: i32, message: v8::UniquePtr<StringBuffer>) {
        if let Some(message) = message.as_ref() {
            match bounded_protocol_text(message.string()) {
                Some(text) => self.0.borrow_mut().enqueue(text),
                None => self.0.borrow_mut().close(),
            }
        }
    }
    fn send_notification(&self, message: v8::UniquePtr<StringBuffer>) {
        if let Some(message) = message.as_ref() {
            let Some(text) = bounded_protocol_text(message.string()) else {
                self.0.borrow_mut().close();
                return;
            };
            let context_id = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .filter(|event| {
                    event.get("method").and_then(serde_json::Value::as_str)
                        == Some("Runtime.executionContextCreated")
                })
                .and_then(|event| {
                    event
                        .pointer("/params/context/id")
                        .and_then(serde_json::Value::as_i64)
                });
            let mut io = self.0.borrow_mut();
            if let Some(context_id) = context_id {
                io.guest_context_id = Some(context_id);
            }
            io.enqueue(text);
        }
    }
    fn flush_protocol_notifications(&self) {
        self.0.borrow_mut().flush();
    }
}

struct Core {
    io: Rc<RefCell<Io>>,
    session: Rc<RefCell<Option<V8InspectorSession>>>,
    state: Weak<RefCell<HostState>>,
    stopped: Arc<AtomicBool>,
    paused: Cell<bool>,
    pre_entry: Cell<bool>,
    waiting_for_debugger: Cell<bool>,
}

impl Core {
    fn dispatch(&self, message: &str) {
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(message) else {
            return;
        };
        let Some(id) = value
            .get("id")
            .and_then(serde_json::Value::as_i64)
            .filter(|id| (1..=i32::MAX as i64).contains(id))
        else {
            return;
        };
        let Some(method) = value.get("method").and_then(serde_json::Value::as_str) else {
            self.deny(id);
            return;
        };
        // Inspector execution commands cannot bypass the pre-entry barrier,
        // even if the configured Policy and Engine Gate would allow them.
        if self.pre_entry.get()
            && !matches!(
                method,
                "Runtime.enable"
                    | "Runtime.runIfWaitingForDebugger"
                    | "Runtime.disable"
                    | "Runtime.getIsolateId"
                    | "Debugger.enable"
                    | "Debugger.disable"
            )
        {
            self.deny(id);
            return;
        }
        let context_field = match method {
            "Runtime.evaluate" => Some("contextId"),
            "Runtime.compileScript" | "Runtime.runScript" => Some("executionContextId"),
            "Runtime.callFunctionOn" if value.pointer("/params/objectId").is_none() => {
                Some("executionContextId")
            }
            _ => None,
        };
        let context_id = self.io.borrow().guest_context_id;
        if value.pointer("/params/uniqueContextId").is_some()
            || ["contextId", "executionContextId"]
                .into_iter()
                .any(|field| {
                    value
                        .get("params")
                        .and_then(|params| params.get(field))
                        .is_some_and(|value| value.as_i64() != context_id)
                })
            || (context_field.is_some() && context_id.is_none())
        {
            self.deny(id);
            return;
        }
        if !self.admit(id as u64, method, &value) {
            self.deny(id);
            return;
        }
        if method == "Runtime.runIfWaitingForDebugger" {
            self.waiting_for_debugger.set(false);
            self.io
                .borrow_mut()
                .enqueue(serde_json::json!({"id": id, "result": {}}).to_string());
            return;
        }
        if let Some(field) = context_field {
            let context_id = context_id.expect("checked before Gate");
            let Some(params) = value
                .get_mut("params")
                .and_then(serde_json::Value::as_object_mut)
            else {
                self.deny(id);
                return;
            };
            params.insert(field.into(), serde_json::json!(context_id));
        }
        if let Some(session) = self.session.borrow().as_ref() {
            let encoded = value.to_string();
            session.dispatch_protocol_message(StringView::from(encoded.as_bytes()));
        }
    }

    fn deny(&self, id: i64) {
        self.io.borrow_mut().enqueue(
            serde_json::json!({
                "id": id, "error": { "code": -32000, "message": "Inspector command denied" }
            })
            .to_string(),
        );
    }

    fn admit(&self, _id: u64, method: &str, command: &serde_json::Value) -> bool {
        let source_field = match method {
            "Runtime.evaluate" | "Runtime.compileScript" | "Debugger.evaluateOnCallFrame" => {
                Some("expression")
            }
            "Runtime.callFunctionOn" => Some("functionDeclaration"),
            "Debugger.setScriptSource" => Some("scriptSource"),
            "Runtime.runScript" => None,
            "Runtime.enable"
            | "Runtime.runIfWaitingForDebugger"
            | "Runtime.disable"
            | "Runtime.getIsolateId"
            | "Debugger.enable"
            | "Debugger.disable"
            | "Debugger.pause"
            | "Debugger.resume"
            | "Debugger.stepInto"
            | "Debugger.stepOut"
            | "Debugger.stepOver" => return true,
            _ => return false,
        };
        let source = match source_field {
            Some(name) => match command
                .pointer(&format!("/params/{name}"))
                .and_then(serde_json::Value::as_str)
            {
                Some(value) if value.len() <= crate::engine_gate::MAX_ENGINE_GATE_SOURCE_BYTES => {
                    Some(value)
                }
                _ => return false,
            },
            None => None,
        };
        if method == "Runtime.evaluate"
            && command
                .pointer("/params/includeCommandLineAPI")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        {
            return false;
        }
        let Some(shared) = self.state.upgrade() else {
            return false;
        };
        let Ok(mut state) = shared.try_borrow_mut() else {
            return false;
        };
        let Some(request_id) = state.engine_gate.next_request_id() else {
            return false;
        };
        let Some(remote) = state.remote.as_ref() else {
            return false;
        };
        let mut request = serde_json::json!({
            "codeKind": "strings", "requestId": request_id,
            "inspectorMethod": method, "sourceAvailable": source.is_some()
        });
        let mut source_prefix = None;
        if let Some(source) = source {
            request["sourceBytes"] = serde_json::json!(source.len());
            request["sourceSha256"] =
                serde_json::json!(format!("{:x}", Sha256::digest(source.as_bytes())));
            let cap = remote.source_reader_max_bytes().min(source.len());
            if cap > 0 {
                source_prefix = Some(zeroize::Zeroizing::new(source.as_bytes()[..cap].to_vec()));
            }
        }
        if method == "Runtime.compileScript"
            && let Some(origin) = command
                .pointer("/params/sourceURL")
                .and_then(serde_json::Value::as_str)
        {
            if origin.len() > 4096 {
                return false;
            }
            if url::Url::parse(origin).is_ok_and(|url| {
                matches!(url.scheme(), "holo" | "holonomy" | "holo-plugins" | "node")
            }) {
                return false;
            }
            // sourceURL is only a caller-controlled V8 display label, never
            // authoritative Engine Gate origin or Loader/HDO evidence.
        }
        let allowed = remote
            .inspector_gate(request_id, request.to_string(), source_prefix)
            .and_then(|response| serde_json::from_str::<serde_json::Value>(&response).ok())
            .is_some_and(|response| {
                response
                    .pointer("/decision/action")
                    .and_then(serde_json::Value::as_str)
                    == Some("allow")
            });
        allowed && !self.stopped.load(std::sync::atomic::Ordering::Acquire)
    }

    fn pump_messages(&self) -> bool {
        let mut progressed = false;
        for _ in 0..MAX_PENDING {
            let message = self.io.borrow_mut().receive();
            let Some(message) = message else {
                break;
            };
            progressed = true;
            self.dispatch(&message);
        }
        self.io.borrow_mut().flush();
        progressed
    }
}

struct Client(Rc<Core>);
impl V8InspectorClientImpl for Client {
    fn run_message_loop_on_pause(&self, _context_group_id: i32) {
        self.0.paused.set(true);
        while self.0.paused.get()
            && !self.0.io.borrow().closed
            && !self.0.stopped.load(std::sync::atomic::Ordering::Acquire)
        {
            if !self.0.pump_messages() {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
    fn quit_message_loop_on_pause(&self) {
        self.0.paused.set(false);
    }
}

pub struct InspectorRuntime {
    inspector: V8Inspector,
    core: Rc<Core>,
}

impl InspectorRuntime {
    pub fn new(
        isolate: &mut v8::OwnedIsolate,
        state: Weak<RefCell<HostState>>,
        path: &Path,
        stopped: Arc<AtomicBool>,
        wait_for_debugger: bool,
    ) -> Result<Self, String> {
        let io = Rc::new(RefCell::new(Io::bind(path)?));
        let core = Rc::new(Core {
            io,
            session: Rc::new(RefCell::new(None)),
            state,
            stopped,
            paused: Cell::new(false),
            pre_entry: Cell::new(wait_for_debugger),
            waiting_for_debugger: Cell::new(wait_for_debugger),
        });
        let inspector = V8Inspector::create(
            isolate,
            V8InspectorClient::new(Box::new(Client(core.clone()))),
        );
        Ok(Self { inspector, core })
    }

    pub fn context_created(&self, context: v8::Local<v8::Context>) {
        self.inspector.context_created(
            context,
            GUEST_GROUP,
            StringView::from(&b"Holonomy Guest"[..]),
            StringView::empty(),
        );
    }

    pub fn context_destroyed(&self, context: v8::Local<v8::Context>) {
        self.inspector.context_destroyed(context);
    }

    pub fn pump(&self) -> bool {
        let accepted = self.core.io.borrow_mut().accept();
        if accepted {
            let channel = Channel::new(Box::new(Output(self.core.io.clone())));
            *self.core.session.borrow_mut() = Some(self.inspector.connect(
                GUEST_GROUP,
                channel,
                StringView::empty(),
                V8InspectorClientTrustLevel::Untrusted,
            ));
        }
        let progressed = accepted | self.core.pump_messages();
        if self.core.io.borrow().closed {
            self.core.session.borrow_mut().take();
        }
        progressed
    }

    pub fn active(&self) -> bool {
        !self.core.io.borrow().closed
    }

    pub fn waiting_for_debugger(&self) -> bool {
        self.core.waiting_for_debugger.get()
    }

    pub fn begin_entry(&self) {
        debug_assert!(!self.waiting_for_debugger());
        self.core.pre_entry.set(false);
    }
}

impl Drop for InspectorRuntime {
    fn drop(&mut self) {
        // Session must release its channel before V8Inspector is destroyed.
        self.core.session.borrow_mut().take();
    }
}
