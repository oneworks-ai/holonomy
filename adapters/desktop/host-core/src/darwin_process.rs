//! Host-private macOS Seatbelt process I/O. The child helper is the sole owner
//! of OS process handles; a Runtime pipe EOF kills every job it created.
#![cfg(target_os = "macos")]

use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    io::{self, BufRead, BufReader, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::MetadataExt,
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

const MAX_REQUEST: usize = 24 * 1024 * 1024;
const MAX_RESPONSE: usize = 48 * 1024 * 1024;
const MAX_EVENTS: usize = 1024;
const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;
// At most 64 jobs * 9 terminal records = 576. Leave 640 slots for them.
const MAX_ORDINARY_EVENTS: usize = 384;
const MAX_DATA_BYTES: usize = 2 * 1024 * 1024;
const MAX_STDIN_CHUNK: usize = 256 * 1024;
const MAX_STDIN_QUEUE: usize = 16 * 1024 * 1024;
const MAX_AGGREGATE_STDIN: usize = 64 * 1024 * 1024;
const MAX_PENDING_WRITES_PER_JOB: usize = 512;
const MAX_JOBS: usize = 64;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn response(result: Result<Value, &'static str>) -> String {
    match result {
        Ok(value) => json!({"schemaVersion":1,"ok":true,"value":value}).to_string(),
        Err(code) => json!({"schemaVersion":1,"ok":false,"code":code}).to_string(),
    }
}

fn object<'a>(
    value: &'a Value,
    keys: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, &'static str> {
    let map = value.as_object().ok_or("invalid")?;
    if map.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err("invalid");
    }
    Ok(map)
}
fn string(value: &Value, max: usize) -> Result<&str, &'static str> {
    let text = value.as_str().ok_or("invalid")?;
    if text.is_empty() || text.len() > max || text.contains('\0') {
        return Err("invalid");
    }
    Ok(text)
}
fn maybe_empty_string(value: &Value, max: usize) -> Result<&str, &'static str> {
    let text = value.as_str().ok_or("invalid")?;
    if text.len() > max || text.contains('\0') {
        return Err("invalid");
    }
    Ok(text)
}
fn number(value: &Value, min: u64, max: u64) -> Result<u64, &'static str> {
    let n = value.as_u64().ok_or("invalid")?;
    if !(min..=max).contains(&n) {
        return Err("invalid");
    }
    Ok(n)
}
fn identifier(value: &Value) -> Result<String, &'static str> {
    let text = string(value, 128)?;
    if !text.as_bytes()[0].is_ascii_alphanumeric()
        || !text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err("invalid");
    }
    Ok(text.to_owned())
}
fn path(value: &Value) -> Result<PathBuf, &'static str> {
    let text = string(value, 4096)?;
    if !text.starts_with('/')
        || text.ends_with('/')
        || text
            .split('/')
            .skip(1)
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("invalid");
    }
    Ok(PathBuf::from(text))
}
fn executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    metadata.is_file() && metadata.mode() & 0o111 != 0
}
fn sbpl_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}
fn set_nonblocking(fd: i32) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
fn signal_number(name: &str) -> Result<i32, &'static str> {
    match name {
        "SIGINT" => Ok(libc::SIGINT),
        "SIGTERM" => Ok(libc::SIGTERM),
        "SIGKILL" => Ok(libc::SIGKILL),
        _ => Err("invalid"),
    }
}
fn signal_name(number: Option<i32>) -> Option<&'static str> {
    match number {
        Some(libc::SIGHUP) => Some("SIGHUP"),
        Some(libc::SIGINT) => Some("SIGINT"),
        Some(libc::SIGQUIT) => Some("SIGQUIT"),
        Some(libc::SIGABRT) => Some("SIGABRT"),
        Some(libc::SIGBUS) => Some("SIGBUS"),
        Some(libc::SIGSEGV) => Some("SIGSEGV"),
        Some(libc::SIGPIPE) => Some("SIGPIPE"),
        Some(libc::SIGALRM) => Some("SIGALRM"),
        Some(libc::SIGTERM) => Some("SIGTERM"),
        Some(libc::SIGKILL) => Some("SIGKILL"),
        _ => None,
    }
}

#[derive(Clone)]
struct Program {
    path: PathBuf,
    fixed_args: Vec<String>,
    shell: bool,
    argument_bytes: usize,
}
struct Installation {
    generation: u64,
    source: Value,
    policy: Value,
    sandbox: PathBuf,
    read_paths: Vec<PathBuf>,
    programs: BTreeMap<String, Program>,
    env_names: Vec<String>,
    max_env_value: usize,
    max_concurrent: usize,
    max_total: u64,
    max_pipes: usize,
    max_stdin: usize,
    max_stdout: usize,
    max_stderr: usize,
    max_time: u64,
}
impl Installation {
    fn parse(source: &Value, policy: &Value, generation: u64) -> Result<Self, &'static str> {
        object(
            source,
            &[
                "profile",
                "backend",
                "environment",
                "executables",
                "defaultShellExecutableId",
            ],
        )?;
        if source["profile"] != "process-profile-v1"
            || source["backend"]["backendId"] != "native.darwin-seatbelt-v1"
        {
            return Err("invalid");
        }
        let config = &source["backend"]["configuration"];
        object(config, &["runtimeReadPaths", "sandboxExecutablePath"])?;
        let sandbox = path(&config["sandboxExecutablePath"])?;
        if sandbox != Path::new("/usr/bin/sandbox-exec") || !executable(&sandbox) {
            return Err("unavailable");
        }
        let sandbox_meta = sandbox.metadata().map_err(|_| "unavailable")?;
        if sandbox_meta.uid() != 0 || sandbox_meta.mode() & 0o022 != 0 {
            return Err("unavailable");
        }
        let reads = config["runtimeReadPaths"].as_array().ok_or("invalid")?;
        if reads.len() > 64 {
            return Err("invalid");
        }
        let mut read_paths = Vec::new();
        for item in reads {
            let selected = path(item)?;
            if [
                "/", "/Users", "/Volumes", "/private", "/tmp", "/var", "/etc", "/home",
            ]
            .contains(&selected.to_string_lossy().as_ref())
                || read_paths.contains(&selected)
            {
                return Err("invalid");
            }
            read_paths.push(selected);
        }
        if source["environment"]["defaultScope"] != "processTree"
            || source["environment"]["allowedScopes"] != json!(["processTree"])
        {
            return Err("invalid");
        }
        object(
            policy,
            &[
                "access",
                "environment",
                "executables",
                "limits",
                "mounts",
                "network",
                "shell",
            ],
        )?;
        if policy["access"] != "sandboxed"
            || policy["network"]["access"] != "none"
            || policy["mounts"] != json!([])
            || policy["limits"]["maxWritableRootfsBytes"] != 0
        {
            return Err("invalid");
        }
        let limits = &policy["limits"];
        object(
            limits,
            &[
                "maxConcurrentProcesses",
                "maxExecutionTimeMs",
                "maxOpenPipes",
                "maxProcessTreeDepth",
                "maxStderrBytes",
                "maxStdinBytes",
                "maxStdoutBytes",
                "maxTotalProcesses",
                "maxWritableRootfsBytes",
            ],
        )?;
        let max_concurrent = number(&limits["maxConcurrentProcesses"], 1, 64)? as usize;
        // This is a Policy ceiling. Seatbelt v1 still denies process-fork and
        // therefore permits only one actual process level.
        number(&limits["maxProcessTreeDepth"], 1, 32)?;
        let max_total = number(&limits["maxTotalProcesses"], 1, 100_000)?;
        let max_pipes = number(&limits["maxOpenPipes"], 0, 256)? as usize;
        let max_stdin = number(&limits["maxStdinBytes"], 1, 16 * 1024 * 1024)? as usize;
        let max_stdout = number(&limits["maxStdoutBytes"], 1, 16 * 1024 * 1024)? as usize;
        let max_stderr = number(&limits["maxStderrBytes"], 1, 16 * 1024 * 1024)? as usize;
        let max_time = number(&limits["maxExecutionTimeMs"], 1, 86_400_000)?;
        if max_concurrent as u64 > max_total {
            return Err("invalid");
        }
        let env = &policy["environment"];
        object(env, &["allowedNames", "maxValueBytes"])?;
        let env_names = env["allowedNames"]
            .as_array()
            .ok_or("invalid")?
            .iter()
            .map(identifier)
            .collect::<Result<Vec<_>, _>>()?;
        if env_names.len() > 128 {
            return Err("invalid");
        }
        let max_env_value = number(&env["maxValueBytes"], 0, 64 * 1024)? as usize;
        let allowed = policy["executables"].as_array().ok_or("invalid")?;
        let entries = source["executables"].as_array().ok_or("invalid")?;
        if entries.is_empty() || entries.len() > 256 {
            return Err("invalid");
        }
        let mut programs = BTreeMap::new();
        for entry in entries {
            object(
                entry,
                &[
                    "executableId",
                    "executable",
                    "executablePath",
                    "fixedArgs",
                    "shell",
                ],
            )?;
            let id = identifier(&entry["executableId"])?;
            let locator = if entry.get("executable").is_some() {
                object(&entry["executable"], &["kind", "path"])?;
                if entry["executable"]["kind"] != "hostPath"
                    || entry.get("executablePath").is_some()
                {
                    return Err("invalid");
                }
                &entry["executable"]["path"]
            } else {
                &entry["executablePath"]
            };
            let selected = path(locator)?;
            let selected_string = selected.to_string_lossy();
            let owned = ["/bin/", "/System/", "/usr/bin/", "/usr/lib/"]
                .iter()
                .any(|root| selected_string.starts_with(root))
                || read_paths.iter().any(|root| selected.starts_with(root));
            if !owned || !executable(&selected) {
                return Err("unavailable");
            }
            let fixed = entry["fixedArgs"].as_array().ok_or("invalid")?;
            if fixed.len() > 64 {
                return Err("invalid");
            }
            let fixed_args = fixed
                .iter()
                .map(|arg| maybe_empty_string(arg, 64 * 1024).map(str::to_owned))
                .collect::<Result<Vec<_>, _>>()?;
            let policy_entry = allowed
                .iter()
                .find(|candidate| candidate["executableId"] == id)
                .ok_or("invalid")?;
            let argument_bytes =
                number(&policy_entry["argumentBytes"], 1, 16 * 1024 * 1024)? as usize;
            let shell = entry["shell"] == true;
            if programs
                .insert(
                    id,
                    Program {
                        path: selected,
                        fixed_args,
                        shell,
                        argument_bytes,
                    },
                )
                .is_some()
            {
                return Err("invalid");
            }
        }
        Ok(Self {
            generation,
            source: source.clone(),
            policy: policy.clone(),
            sandbox,
            read_paths,
            programs,
            env_names,
            max_env_value,
            max_concurrent,
            max_total,
            max_pipes,
            max_stdin,
            max_stdout,
            max_stderr,
            max_time,
        })
    }
    fn profile_for(&self, program: &Program) -> String {
        let path = program.path.to_string_lossy();
        let mut profile = format!(
            "(version 1)(deny default)(import \"system.sb\")(deny process-fork)(deny network*)(allow process-exec (literal {}))(allow file-read* file-map-executable (literal {})",
            sbpl_string(&path),
            sbpl_string(&path)
        );
        for root in &self.read_paths {
            profile.push_str(&format!(
                " (subpath {})",
                sbpl_string(&root.to_string_lossy())
            ));
        }
        profile.push(')');
        profile
    }
}

struct PendingWrite {
    bytes: Vec<u8>,
    offset: usize,
    callback_id: Option<u64>,
}
struct Job {
    handle: String,
    resource_id: String,
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    writes: VecDeque<PendingWrite>,
    queued_stdin: usize,
    total_stdin: usize,
    end_callback: Option<Option<u64>>,
    stdin_closed: bool,
    stdout_closed: bool,
    stderr_closed: bool,
    status: Option<ExitStatus>,
    started: Instant,
    timeout: Duration,
    stdout_bytes: usize,
    stderr_bytes: usize,
    max_stdout: usize,
    max_stderr: usize,
    sync: bool,
    sync_stdout: Vec<u8>,
    sync_stderr: Vec<u8>,
    sync_error: Option<&'static str>,
    emitted_exit: bool,
}
impl Job {
    fn event(&self, kind: &str) -> Value {
        if matches!(kind, "error" | "stdinError" | "stdoutError" | "stderrError") {
            json!({"handle":self.handle,"processResourceId":self.resource_id,"kind":kind,"code":"EIO"})
        } else {
            json!({"handle":self.handle,"processResourceId":self.resource_id,"kind":kind})
        }
    }
    fn kill(&mut self, signal: i32) {
        if self.status.is_none() {
            // The unreaped Child still owns this PID. A job can change its
            // process group; if the original group is gone, signal the root
            // PID directly. Never signal after try_wait records a status.
            let pid = self.child.id() as i32;
            if unsafe { libc::kill(-pid, signal) } < 0 {
                unsafe {
                    libc::kill(pid, signal);
                }
            }
        }
    }
    fn status_fields(&self) -> (Option<i32>, Option<&'static str>) {
        let status = self.status.as_ref();
        (
            status.and_then(ExitStatus::code),
            signal_name(status.and_then(ExitStatusExt::signal)),
        )
    }
    fn done(&self) -> bool {
        self.status.is_some() && self.stdin_closed && self.stdout_closed && self.stderr_closed
    }
}

enum Input {
    Request(String),
    Eof,
}
fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(None);
        }
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |i| i + 1);
        if bytes.len() + count > MAX_REQUEST {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "oversized private process frame",
            ));
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if bytes.last() == Some(&b'\n') {
            return String::from_utf8(bytes).map(Some).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "invalid private process frame")
            });
        }
    }
}

/// Called by `holo __process_io_v1` before any V8 or Runtime initialization.
pub fn serve_process_io() -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(16);
    thread::Builder::new()
        .name("holo-process-owner-pipe".into())
        .spawn(move || {
            let mut input = BufReader::new(io::stdin());
            while let Ok(Some(frame)) = read_frame(&mut input) {
                if sender.send(Input::Request(frame)).is_err() {
                    return;
                }
            }
            let _ = sender.send(Input::Eof);
        })
        .map_err(|_| "Cannot start private Process owner reader")?;
    let mut worker = Worker::default();
    worker.run(receiver, &mut io::stdout().lock())
}

#[derive(Default)]
struct Worker {
    installed: Option<Installation>,
    jobs: BTreeMap<String, Job>,
    owned_handles: BTreeSet<String>,
    outstanding: BTreeSet<String>,
    events: VecDeque<Value>,
    event_bytes: usize,
    next_handle: u64,
    total: u64,
    closed: bool,
}
impl Worker {
    fn run(&mut self, receiver: Receiver<Input>, output: &mut impl Write) -> Result<(), String> {
        let result = (|| {
            loop {
                self.tick();
                match receiver.recv_timeout(Duration::from_millis(if self.jobs.is_empty() {
                    20
                } else {
                    5
                })) {
                    Ok(Input::Eof) | Err(RecvTimeoutError::Disconnected) => break,
                    Err(RecvTimeoutError::Timeout) => continue,
                    Ok(Input::Request(frame)) => {
                        let result = serde_json::from_str::<Value>(&frame)
                            .map_err(|_| "invalid")
                            .and_then(|request| self.command(&request, &receiver));
                        writeln!(output, "{}", response(result))
                            .map_err(|_| "Private Process owner pipe closed")?;
                        output
                            .flush()
                            .map_err(|_| "Private Process owner pipe closed")?;
                    }
                }
            }
            Ok(())
        })();
        self.shutdown();
        result
    }
    fn command(
        &mut self,
        request: &Value,
        receiver: &Receiver<Input>,
    ) -> Result<Value, &'static str> {
        object(
            request,
            &[
                "schemaVersion",
                "kind",
                "generation",
                "profile",
                "policy",
                "executableId",
                "args",
                "env",
                "stdio",
                "limits",
                "processResourceId",
                "timeout",
                "maxBuffer",
                "encoding",
                "maxEvents",
                "handle",
                "base64",
                "callbackId",
                "index",
                "signal",
            ],
        )?;
        if request["schemaVersion"] != 1 {
            return Err("invalid");
        }
        let kind = string(&request["kind"], 16)?;
        let generation = number(&request["generation"], 1, MAX_SAFE_INTEGER)?;
        if kind == "install" {
            if self.closed {
                return Err("generation");
            }
            let proposed =
                Installation::parse(&request["profile"], &request["policy"], generation)?;
            if let Some(current) = &self.installed {
                return if current.generation == generation
                    && current.source == proposed.source
                    && current.policy == proposed.policy
                {
                    Ok(json!({"installed":true}))
                } else {
                    Err("generation")
                };
            }
            self.installed = Some(proposed);
            return Ok(json!({"installed":true}));
        }
        let installation = self.installed.as_ref().ok_or("unavailable")?;
        if generation != installation.generation {
            return Err("generation");
        }
        if self.closed && kind != "close" {
            return Err("generation");
        }
        match kind {
            "spawn" => self.spawn(request, false),
            "spawnSync" => {
                let handle = self.spawn(request, true)?["handle"]
                    .as_str()
                    .ok_or("io")?
                    .to_owned();
                self.run_sync(&handle, receiver)
            }
            "poll" => {
                let limit = number(&request["maxEvents"], 1, 64)? as usize;
                let mut events = Vec::new();
                for _ in 0..limit {
                    let Some(event) = self.events.pop_front() else {
                        break;
                    };
                    self.event_bytes = self.event_bytes.saturating_sub(event.to_string().len());
                    if event["kind"] == "close"
                        && let Some(handle) = event["handle"].as_str()
                    {
                        self.outstanding.remove(handle);
                    }
                    events.push(event);
                }
                Ok(json!({"events":events,"remaining":self.events.len()}))
            }
            "write" => self.write(request),
            "end" => self.end(request),
            "destroy" => self.destroy(request),
            "signal" => self.signal(request),
            "close" => {
                self.closed = true;
                self.shutdown();
                Ok(json!({}))
            }
            _ => Err("invalid"),
        }
    }
    fn spawn(&mut self, request: &Value, sync: bool) -> Result<Value, &'static str> {
        let installation = self.installed.as_ref().ok_or("unavailable")?;
        let active_sync = self.jobs.values().filter(|job| job.sync).count();
        if request["limits"] != installation.policy["limits"]
            || self.outstanding.len() + active_sync >= installation.max_concurrent.min(MAX_JOBS)
            || self.total >= installation.max_total
        {
            return Err("limit");
        }
        let id = identifier(&request["executableId"])?;
        let program = installation.programs.get(&id).ok_or("unavailable")?;
        let args = request["args"].as_array().ok_or("invalid")?;
        if args.len() > 256 || args.len() < program.fixed_args.len() {
            return Err("invalid");
        }
        let mut command_args = Vec::new();
        let mut arg_bytes = 0usize;
        for arg in args {
            let text = maybe_empty_string(arg, 64 * 1024)?;
            arg_bytes = arg_bytes.checked_add(text.len()).ok_or("limit")?;
            command_args.push(text.to_owned());
        }
        if command_args[..program.fixed_args.len()] != program.fixed_args
            || arg_bytes > program.argument_bytes
        {
            return Err("limit");
        }
        if program.shell && installation.policy["shell"]["access"] != "restricted" {
            return Err("invalid");
        }
        let env = request["env"].as_object().ok_or("invalid")?;
        if env.len() > installation.env_names.len() {
            return Err("invalid");
        }
        for (name, value) in env {
            if !installation.env_names.contains(name)
                || maybe_empty_string(value, installation.max_env_value)?.len()
                    > installation.max_env_value
            {
                return Err("invalid");
            }
        }
        let stdio = request["stdio"].as_array().ok_or("invalid")?;
        if stdio.len() != 3
            || stdio
                .iter()
                .any(|value| value != "pipe" && value != "ignore")
        {
            return Err("invalid");
        }
        let pipes = stdio.iter().filter(|item| *item == "pipe").count();
        let active_pipes = self
            .jobs
            .values()
            .map(|job| {
                usize::from(job.stdin.is_some())
                    + usize::from(job.stdout.is_some())
                    + usize::from(job.stderr.is_some())
            })
            .sum::<usize>();
        if pipes + active_pipes > installation.max_pipes {
            return Err("limit");
        }
        let resource_id = string(&request["processResourceId"], 128)?;
        let resource_prefix = if sync {
            format!("sync-{}-", installation.generation)
        } else {
            "process-".to_owned()
        };
        if resource_id
            .strip_prefix(&resource_prefix)
            .is_none_or(|suffix| suffix.is_empty() || !suffix.bytes().all(|b| b.is_ascii_digit()))
            || self.jobs.values().any(|job| job.resource_id == resource_id)
        {
            return Err("invalid");
        }
        let timeout = if sync {
            number(&request["timeout"], 1, installation.max_time)?
        } else {
            installation.max_time
        };
        let max_buffer = if sync {
            number(
                &request["maxBuffer"],
                1,
                installation.max_stdout.min(installation.max_stderr) as u64,
            )? as usize
        } else {
            0
        };
        if sync && request["encoding"] != "utf8" && request["encoding"] != "buffer" {
            return Err("invalid");
        }
        let profile = installation.profile_for(program);
        let mut command = Command::new(&installation.sandbox);
        command
            .arg("-p")
            .arg(profile)
            .arg(&program.path)
            .args(&command_args)
            .current_dir("/")
            .env_clear()
            .process_group(0);
        for (name, value) in env {
            command.env(name, value.as_str().ok_or("invalid")?);
        }
        command.stdin(if stdio[0] == "pipe" {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        command.stdout(if stdio[1] == "pipe" {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        command.stderr(if stdio[2] == "pipe" {
            Stdio::piped()
        } else {
            Stdio::null()
        });
        self.next_handle = self.next_handle.checked_add(1).ok_or("limit")?;
        let handle = format!("job-{}", self.next_handle);
        self.total += 1;
        self.owned_handles.insert(handle.clone());
        if !sync {
            self.outstanding.insert(handle.clone());
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) if !sync => {
                self.queue_event(
                    json!({"handle":handle,"processResourceId":resource_id,"kind":"error","code":"EIO"}),
                );
                self.queue_event(json!({"handle":handle,"processResourceId":resource_id,"kind":"close","status":null,"signal":null}));
                return Ok(json!({"handle":handle}));
            }
            Err(_) => return Err("unavailable"),
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        for fd in [
            stdin.as_ref().map(AsRawFd::as_raw_fd),
            stdout.as_ref().map(AsRawFd::as_raw_fd),
            stderr.as_ref().map(AsRawFd::as_raw_fd),
        ]
        .into_iter()
        .flatten()
        {
            if set_nonblocking(fd).is_err() {
                let pid = child.id() as i32;
                if unsafe { libc::kill(-pid, libc::SIGKILL) } < 0 {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
                let deadline = Instant::now() + Duration::from_millis(100);
                while Instant::now() < deadline && child.try_wait().ok().flatten().is_none() {
                    thread::sleep(Duration::from_millis(5));
                }
                if !sync {
                    self.queue_event(json!({"handle":handle,"processResourceId":resource_id,"kind":"error","code":"EIO"}));
                    self.queue_event(json!({"handle":handle,"processResourceId":resource_id,"kind":"close","status":null,"signal":null}));
                    return Ok(json!({"handle":handle}));
                }
                return Err("io");
            }
        }
        let stdin = if sync {
            // The shared synchronous surface has no stdin input option. Close
            // immediately, as spawnSync does, so a reader sees EOF.
            drop(stdin);
            None
        } else {
            stdin
        };
        let job = Job {
            handle: handle.clone(),
            resource_id: resource_id.into(),
            child,
            stdin,
            stdout,
            stderr,
            writes: VecDeque::new(),
            queued_stdin: 0,
            total_stdin: 0,
            end_callback: None,
            stdin_closed: sync || stdio[0] != "pipe",
            stdout_closed: stdio[1] != "pipe",
            stderr_closed: stdio[2] != "pipe",
            status: None,
            started: Instant::now(),
            timeout: Duration::from_millis(timeout),
            stdout_bytes: 0,
            stderr_bytes: 0,
            max_stdout: if sync {
                max_buffer
            } else {
                installation.max_stdout
            },
            max_stderr: if sync {
                max_buffer
            } else {
                installation.max_stderr
            },
            sync,
            sync_stdout: Vec::new(),
            sync_stderr: Vec::new(),
            sync_error: None,
            emitted_exit: false,
        };
        if !sync {
            self.queue_event(job.event("spawn"));
        }
        self.jobs.insert(handle.clone(), job);
        Ok(json!({"handle":handle}))
    }
    fn write(&mut self, request: &Value) -> Result<Value, &'static str> {
        let handle = string(&request["handle"], 32)?;
        let bytes = STANDARD
            .decode(maybe_empty_string(&request["base64"], 4 * MAX_STDIN_CHUNK)?)
            .map_err(|_| "invalid")?;
        if STANDARD.encode(&bytes) != request["base64"] {
            return Err("invalid");
        }
        let callback_id = request
            .get("callbackId")
            .filter(|v| !v.is_null())
            .map(|v| number(v, 1, MAX_SAFE_INTEGER))
            .transpose()?;
        let max_stdin = self.installed.as_ref().ok_or("unavailable")?.max_stdin;
        let aggregate_stdin = self
            .jobs
            .values()
            .map(|job| job.queued_stdin)
            .sum::<usize>();
        let job = self.jobs.get_mut(handle).ok_or("generation")?;
        if job.stdin.is_none()
            || job.end_callback.is_some()
            || bytes.len() > MAX_STDIN_CHUNK
            || job.writes.len() >= MAX_PENDING_WRITES_PER_JOB
            || job.queued_stdin + bytes.len() > MAX_STDIN_QUEUE
            || aggregate_stdin + bytes.len() > MAX_AGGREGATE_STDIN
            || job.total_stdin + bytes.len() > max_stdin
        {
            return Err("limit");
        }
        job.total_stdin += bytes.len();
        job.queued_stdin += bytes.len();
        job.writes.push_back(PendingWrite {
            bytes,
            offset: 0,
            callback_id,
        });
        Ok(json!({"accepted":job.queued_stdin <= 16 * 1024}))
    }
    fn end(&mut self, request: &Value) -> Result<Value, &'static str> {
        let handle = string(&request["handle"], 32)?;
        let callback_id = request
            .get("callbackId")
            .filter(|v| !v.is_null())
            .map(|v| number(v, 1, MAX_SAFE_INTEGER))
            .transpose()?;
        let job = self.jobs.get_mut(handle).ok_or("generation")?;
        if job.stdin.is_none() || job.end_callback.is_some() {
            return Err("generation");
        }
        job.end_callback = Some(callback_id);
        Ok(json!({}))
    }
    fn destroy(&mut self, request: &Value) -> Result<Value, &'static str> {
        let handle = string(&request["handle"], 32)?;
        let index = number(&request["index"], 0, 2)?;
        if !self.jobs.contains_key(handle) {
            return if self.owned_handles.contains(handle) {
                Ok(json!({}))
            } else {
                Err("generation")
            };
        }
        let mut events = Vec::new();
        let job = self.jobs.get_mut(handle).ok_or("generation")?;
        match index {
            0 => {
                if job.stdin.take().is_some() {
                    job.stdin_closed = true;
                    job.writes.clear();
                    job.queued_stdin = 0;
                    job.end_callback.take();
                    // Shared stdinClose settles every still-pending callback
                    // exactly once; do not enqueue hundreds of redundant IDs.
                    events.push(job.event("stdinError"));
                    events.push(job.event("stdinClose"));
                }
            }
            1 => {
                if job.stdout.take().is_some() {
                    job.stdout_closed = true;
                    events.push(job.event("stdoutClose"));
                }
            }
            _ => {
                if job.stderr.take().is_some() {
                    job.stderr_closed = true;
                    events.push(job.event("stderrClose"));
                }
            }
        }
        for event in events {
            self.queue_event(event);
        }
        Ok(json!({}))
    }
    fn signal(&mut self, request: &Value) -> Result<Value, &'static str> {
        let handle = string(&request["handle"], 32)?;
        let signal = signal_number(string(&request["signal"], 16)?)?;
        if !self.jobs.contains_key(handle) {
            return if self.owned_handles.contains(handle) {
                Ok(json!({}))
            } else {
                Err("generation")
            };
        }
        let job = self.jobs.get_mut(handle).ok_or("generation")?;
        job.kill(signal);
        Ok(json!({}))
    }
    fn run_sync(
        &mut self,
        handle: &str,
        receiver: &Receiver<Input>,
    ) -> Result<Value, &'static str> {
        loop {
            self.tick();
            if self.jobs.get(handle).is_some_and(Job::done) {
                let job = self.jobs.remove(handle).ok_or("io")?;
                let (status, signal) = job.status_fields();
                return Ok(
                    json!({"status":status,"signal":signal,"stdoutBase64":STANDARD.encode(job.sync_stdout),"stderrBase64":STANDARD.encode(job.sync_stderr),"errorCode":job.sync_error}),
                );
            }
            match receiver.recv_timeout(Duration::from_millis(5)) {
                Ok(Input::Eof) | Err(RecvTimeoutError::Disconnected) => {
                    self.shutdown();
                    return Err("io");
                }
                _ => {}
            }
        }
    }
    fn queue_event(&mut self, event: Value) -> bool {
        let length = event.to_string().len();
        if self.events.len() < MAX_EVENTS && self.event_bytes + length <= MAX_EVENT_BYTES {
            self.event_bytes += length;
            self.events.push_back(event);
            true
        } else if let Some(job) = event["handle"]
            .as_str()
            .and_then(|handle| self.jobs.get_mut(handle))
        {
            job.kill(libc::SIGKILL);
            false
        } else {
            false
        }
    }
    fn tick(&mut self) {
        let mut events = Vec::new();
        // Keep child pipes unread when Host polling falls behind. OS pipe
        // backpressure is bounded and preserves data until the next poll.
        let mut data_budget_bytes = MAX_DATA_BYTES.saturating_sub(self.event_bytes);
        let ordinary_events = self
            .events
            .iter()
            .filter(|entry| {
                matches!(
                    entry["kind"].as_str(),
                    Some("stdout" | "stderr" | "stdinCallback")
                )
            })
            .count();
        let mut ordinary_budget = MAX_ORDINARY_EVENTS.saturating_sub(ordinary_events);
        for (handle, job) in &mut self.jobs {
            if job.status.is_none() && job.started.elapsed() >= job.timeout {
                job.sync_error.get_or_insert("ETIMEDOUT");
                job.kill(libc::SIGKILL);
            }
            if job.sync || (data_budget_bytes >= 16 * 1024 && ordinary_budget >= 4) {
                flush_stdin(job, &mut events);
                read_stream(job, 1, &mut events);
                read_stream(job, 2, &mut events);
                if !job.sync {
                    data_budget_bytes = data_budget_bytes.saturating_sub(16 * 1024);
                    ordinary_budget = ordinary_budget.saturating_sub(4);
                }
            }
            if job.status.is_none()
                && let Ok(Some(status)) = job.child.try_wait()
            {
                job.status = Some(status);
                if job.stdin.take().is_some() {
                    job.stdin_closed = true;
                    events.push(job.event("stdinClose"));
                }
            }
            if job.status.is_some() && !job.emitted_exit {
                job.emitted_exit = true;
                let (status, signal) = job.status_fields();
                if !job.sync {
                    events.push(json!({"handle":handle,"processResourceId":job.resource_id,"kind":"exit","status":status,"signal":signal}));
                }
            }
            if job.done() && !job.sync {
                let (status, signal) = job.status_fields();
                events.push(json!({"handle":handle,"processResourceId":job.resource_id,"kind":"close","status":status,"signal":signal}));
            }
        }
        let mut completed = Vec::new();
        for event in events {
            let closed_handle = (event["kind"] == "close")
                .then(|| event["handle"].as_str().map(str::to_owned))
                .flatten();
            if self.queue_event(event)
                && let Some(handle) = closed_handle
            {
                completed.push(handle);
            }
        }
        for handle in completed {
            self.jobs.remove(&handle);
        }
    }
    fn shutdown(&mut self) {
        for job in self.jobs.values_mut() {
            job.kill(libc::SIGKILL);
            job.stdin.take();
        }
        let until = Instant::now() + Duration::from_secs(1);
        while !self.jobs.is_empty() && Instant::now() < until {
            self.tick();
            if self.jobs.values().all(|job| job.status.is_some()) {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        for job in self.jobs.values_mut() {
            job.kill(libc::SIGKILL);
            let _ = job.child.try_wait();
        }
        self.jobs.clear();
        self.events.clear();
        self.event_bytes = 0;
        self.owned_handles.clear();
        self.outstanding.clear();
    }
}

fn flush_stdin(job: &mut Job, events: &mut Vec<Value>) {
    if let Some(stdin) = job.stdin.as_mut() {
        if let Some(front) = job.writes.front_mut() {
            if front.offset == front.bytes.len() {
                // An empty write still completes its callback exactly once.
            } else {
                match stdin.write(&front.bytes[front.offset..]) {
                    Ok(n) if n > 0 => {
                        front.offset += n;
                        job.queued_stdin = job.queued_stdin.saturating_sub(n);
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                    _ => {
                        job.stdin.take();
                        job.stdin_closed = true;
                        events.push(job.event("stdinError"));
                        events.push(job.event("stdinClose"));
                    }
                }
            }
            if job
                .writes
                .front()
                .is_some_and(|write| write.offset == write.bytes.len())
                && let Some(write) = job.writes.pop_front()
                && let Some(id) = write.callback_id
            {
                events.push(json!({"handle":job.handle,"processResourceId":job.resource_id,"kind":"stdinCallback","callbackId":id,"code":null}));
            }
        }
        if job.writes.is_empty()
            && let Some(callback_id) = job.end_callback.take()
        {
            job.stdin.take();
            job.stdin_closed = true;
            if let Some(id) = callback_id {
                events.push(json!({"handle":job.handle,"processResourceId":job.resource_id,"kind":"stdinCallback","callbackId":id,"code":null}));
            }
            events.push(job.event("stdinClose"));
        }
    }
}

fn read_stream(job: &mut Job, index: usize, events: &mut Vec<Value>) {
    let mut bytes = [0u8; 4096];
    let result = if index == 1 {
        job.stdout.as_mut().map(|stream| stream.read(&mut bytes))
    } else {
        job.stderr.as_mut().map(|stream| stream.read(&mut bytes))
    };
    let Some(result) = result else {
        return;
    };
    match result {
        Ok(n) if n > 0 => {
            let (count, max) = if index == 1 {
                (&mut job.stdout_bytes, job.max_stdout)
            } else {
                (&mut job.stderr_bytes, job.max_stderr)
            };
            *count += n;
            if job.sync {
                let destination = if index == 1 {
                    &mut job.sync_stdout
                } else {
                    &mut job.sync_stderr
                };
                let available = max.saturating_sub(destination.len());
                destination.extend_from_slice(&bytes[..n.min(available)]);
                if *count > max {
                    job.sync_error.get_or_insert("ENOBUFS");
                    job.kill(libc::SIGKILL);
                }
            } else {
                events.push(json!({"handle":job.handle,"processResourceId":job.resource_id,"kind":if index == 1 {"stdout"} else {"stderr"},"base64":STANDARD.encode(&bytes[..n])}));
                if *count > max {
                    job.kill(libc::SIGKILL);
                }
            }
        }
        Ok(0) => {
            if index == 1 {
                job.stdout.take();
                job.stdout_closed = true;
            } else {
                job.stderr.take();
                job.stderr_closed = true;
            }
            if !job.sync {
                events.push(job.event(if index == 1 { "stdoutEnd" } else { "stderrEnd" }));
                events.push(job.event(if index == 1 {
                    "stdoutClose"
                } else {
                    "stderrClose"
                }));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
        _ => {
            if index == 1 {
                job.stdout.take();
                job.stdout_closed = true;
            } else {
                job.stderr.take();
                job.stderr_closed = true;
            }
            if !job.sync {
                events.push(job.event(if index == 1 {
                    "stdoutError"
                } else {
                    "stderrError"
                }));
                events.push(job.event(if index == 1 {
                    "stdoutClose"
                } else {
                    "stderrClose"
                }));
            }
        }
    }
}

/// Synchronous Host-side control pipe. The subprocess keeps all OS handles so
/// forced Runtime death closes this pipe and triggers independent cleanup.
pub struct ProcessIoClient {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    read_buffer: Vec<u8>,
}
impl ProcessIoClient {
    pub fn new() -> Result<Self, String> {
        let executable =
            std::env::current_exe().map_err(|_| "Private Process helper unavailable")?;
        let mut child = Command::new(executable)
            .arg("__process_io_v1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Private Process helper unavailable")?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Private Process helper unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Private Process helper unavailable")?;
        let client = Self {
            child,
            stdin: Some(stdin),
            stdout: Some(stdout),
            read_buffer: Vec::new(),
        };
        if set_nonblocking(client.stdin.as_ref().unwrap().as_raw_fd()).is_err()
            || set_nonblocking(client.stdout.as_ref().unwrap().as_raw_fd()).is_err()
        {
            return Err("Private Process helper unavailable".into());
        }
        Ok(client)
    }
    fn fail(&mut self) -> String {
        self.stdin.take();
        self.stdout.take();
        response(Err("io"))
    }
    pub fn command_cancelled(
        &mut self,
        encoded: &str,
        mut cancelled: impl FnMut() -> bool,
    ) -> String {
        let invalid = || response(Err("invalid"));
        if encoded.len() > MAX_REQUEST - 1 || encoded.contains('\n') {
            return invalid();
        }
        let parsed: Value = match serde_json::from_str(encoded) {
            Ok(value) => value,
            Err(_) => return invalid(),
        };
        let timeout = if parsed["kind"] == "spawnSync" {
            parsed["timeout"].as_u64().unwrap_or(0).min(86_400_000) + 2_000
        } else {
            2_000
        };
        let deadline = Instant::now() + Duration::from_millis(timeout);
        let mut bytes = encoded.as_bytes().to_vec();
        bytes.push(b'\n');
        let mut offset = 0;
        while offset < bytes.len() {
            if cancelled() || Instant::now() >= deadline {
                return self.fail();
            }
            let Some(stdin) = self.stdin.as_mut() else {
                return self.fail();
            };
            match stdin.write(&bytes[offset..]) {
                Ok(0) => return self.fail(),
                Ok(n) => offset += n,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(_) => return self.fail(),
            }
        }
        loop {
            if let Some(end) = self.read_buffer.iter().position(|b| *b == b'\n') {
                let frame = self.read_buffer.drain(..=end).collect::<Vec<_>>();
                return String::from_utf8(frame).unwrap_or_else(|_| self.fail());
            }
            if cancelled() || Instant::now() >= deadline || self.read_buffer.len() > MAX_RESPONSE {
                return self.fail();
            }
            let mut chunk = [0u8; 8192];
            let Some(stdout) = self.stdout.as_mut() else {
                return self.fail();
            };
            match stdout.read(&mut chunk) {
                Ok(0) => return self.fail(),
                Ok(n) => self.read_buffer.extend_from_slice(&chunk[..n]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(_) => return self.fail(),
            }
        }
    }
}
impl Drop for ProcessIoClient {
    fn drop(&mut self) {
        self.stdin.take(); // owner EOF is the worker's cleanup trigger
        self.stdout.take(); // unblock a worker writing a response after owner cancellation
        let until = Instant::now() + Duration::from_secs(1);
        while Instant::now() < until {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
