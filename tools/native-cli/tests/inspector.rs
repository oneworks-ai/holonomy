#![cfg(unix)]

use holonomy_desktop_host::{HostConfiguration, RuntimeLaunch};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    root: PathBuf,
    socket: PathBuf,
}

impl Fixture {
    fn new(policy: Value, plugin: Option<&str>) -> Self {
        let root = std::env::temp_dir().join(format!(
            "hi-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = root.join("cdp.sock");
        fs::write(root.join("entry.mjs"),
            "setInterval(() => { if (globalThis.stopInspector) process.exit(0) }, 10); setTimeout(() => process.exit(0), 3000); console.log('INSPECTOR_ENTRY');").unwrap();
        let plugins = if let Some(source) = plugin {
            fs::write(root.join("plugin.mjs"), source).unwrap();
            json!([{"id":"gate","use":"./plugin.mjs"}])
        } else {
            json!([])
        };
        fs::write(
            root.join("host.json"),
            json!({
                "schemaVersion": 1, "sandboxPolicy": policy, "plugins": plugins
            })
            .to_string(),
        )
        .unwrap();
        Self { root, socket }
    }

    fn spawn(&self) -> Child {
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--timeout",
                "6000",
                "--host-config",
                "host.json",
                "--inspector-socket",
            ])
            .arg(&self.socket)
            .arg("entry.mjs")
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", "")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }

    fn connect(&self) -> UnixStream {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            // bind() publishes the path before the Host applies its final
            // private mode. Do not mistake kernel connectability for readiness.
            if fs::symlink_metadata(&self.socket)
                .is_ok_and(|metadata| metadata.permissions().mode() & 0o777 == 0o600)
                && let Ok(stream) = UnixStream::connect(&self.socket)
            {
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                assert_eq!(
                    fs::metadata(&self.socket).unwrap().permissions().mode() & 0o777,
                    0o600
                );
                return stream;
            }
            assert!(
                Instant::now() < deadline,
                "Inspector socket was not created with private permissions"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn spawn_wait(&self, timeout: u64) -> (Child, ChildStdin) {
        let launch = RuntimeLaunch {
            workspace_root: None,
            schema_version: 1,
            generation: 1,
            entry: self.root.join("entry.mjs"),
            argv: vec![],
            timeout: Some(timeout),
            test_mode: false,
            host_config: Some(HostConfiguration::read(&self.root.join("host.json")).unwrap()),
            watch_config: None,
            service_plugin_config: None,
            process_profiles_manifest: None,
            service_plugin_revision: None,
            inspector_socket: Some(self.socket.clone()),
            inspector_wait_for_debugger: true,
            module_allowlist: None,
            module_aliases: None,
            module_metadata_only: vec![],
        };
        let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
            .arg("__runtime")
            .env_clear()
            .env("PATH", "")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        writeln!(input, "{}", launch.encode().unwrap()).unwrap();
        input.flush().unwrap();
        (child, input)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn command(
    stream: &mut UnixStream,
    reader: &mut BufReader<UnixStream>,
    id: i64,
    method: &str,
    params: Value,
) -> Value {
    stream
        .write_all(format!("{}\n", json!({"id":id,"method":method,"params":params})).as_bytes())
        .unwrap();
    for _ in 0..128 {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        if response.get("id").and_then(Value::as_i64) == Some(id) {
            return response;
        }
    }
    panic!("Inspector response was not returned");
}

fn controlled_policy(inspector: Value) -> Value {
    json!({"schemaVersion":2,
      "codeGeneration":{"strings":{"access":"controlled","maxSourceBytes":4096,"maxOperations":16,"decisionTimeoutMs":1000},"wasm":{"access":"none"},"dynamicImport":{"access":"none"}},
      "inspector": inspector})
}

fn wait_for_exit(child: &mut Child, limit: Duration) -> std::process::ExitStatus {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Runtime did not exit within {limit:?}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn private_launch_rejects_wait_without_inspector_socket_and_bad_type() {
    let entry = std::env::current_exe().unwrap();
    let base = json!({
        "schemaVersion":1, "generation":1, "entry":entry,
        "argv":[], "timeout":1000, "testMode":false,
        "hostConfig":null, "inspectorWaitForDebugger":true
    });
    for launch in [base.clone(), {
        let mut value = base;
        value["inspectorWaitForDebugger"] = json!("true");
        value
    }] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
            .arg("__runtime")
            .env_clear()
            .env("PATH", "")
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        writeln!(child.stdin.take().unwrap(), "{launch}").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("launch"));
    }
}

#[test]
fn guest_entry_waits_for_inspector_resume_on_the_guest_thread() {
    let fixture = Fixture::new(
        controlled_policy(json!({"evaluate":true})),
        Some(
            "export default c=>{c.holo.engineGate(r=>r.entryDetail?.source==='inspector'?{action:'allow'}:{action:'deny',reasonCode:'host.denied'});}",
        ),
    );
    fs::write(
        fixture.root.join("entry.mjs"),
        "globalThis.inspectorEntryCount = (globalThis.inspectorEntryCount || 0) + 1; console.log('INSPECTOR_ENTRY');",
    )
    .unwrap();
    let (mut child, input) = fixture.spawn_wait(6000);
    let mut stream = fixture.connect();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    assert!(
        command(&mut stream, &mut reader, 1, "Runtime.enable", json!({}))
            .get("result")
            .is_some()
    );
    // A Policy-permitted execution command must still be held outside the
    // Guest until the pre-entry barrier is explicitly released.
    let denied = command(
        &mut stream,
        &mut reader,
        2,
        "Runtime.evaluate",
        json!({"expression":"globalThis.escape=true"}),
    );
    assert_eq!(
        denied.pointer("/error/code").and_then(Value::as_i64),
        Some(-32000)
    );
    let (send, receive) = mpsc::channel();
    let stdout = child.stdout.take().unwrap();
    let reader_thread = std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line);
        let _ = send.send((result, line));
    });
    assert!(matches!(
        receive.recv_timeout(Duration::from_millis(300)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    assert!(
        child.try_wait().unwrap().is_none(),
        "Runtime exited before resume"
    );
    let released = command(
        &mut stream,
        &mut reader,
        3,
        "Runtime.runIfWaitingForDebugger",
        json!({}),
    );
    assert!(released.get("result").is_some(), "{released}");
    let (read, line) = receive.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(
        read.unwrap() > 0 && line.contains("INSPECTOR_ENTRY"),
        "{line}"
    );
    reader_thread.join().unwrap();
    let repeated = command(
        &mut stream,
        &mut reader,
        4,
        "Runtime.runIfWaitingForDebugger",
        json!({}),
    );
    assert!(repeated.get("result").is_some(), "{repeated}");
    let evaluated = command(
        &mut stream,
        &mut reader,
        5,
        "Runtime.evaluate",
        json!({"expression":"6*7"}),
    );
    assert_eq!(
        evaluated
            .pointer("/result/result/value")
            .and_then(Value::as_i64),
        Some(42),
        "{evaluated}"
    );
    let entry_count = command(
        &mut stream,
        &mut reader,
        6,
        "Runtime.evaluate",
        json!({"expression":"globalThis.inspectorEntryCount"}),
    );
    assert_eq!(
        entry_count
            .pointer("/result/result/value")
            .and_then(Value::as_i64),
        Some(1),
        "{entry_count}"
    );
    drop(reader);
    drop(stream);
    let status = wait_for_exit(&mut child, Duration::from_secs(2));
    assert!(status.success(), "{status}");
    drop(input);
    assert!(!fixture.socket.exists());
}

#[test]
fn early_resume_keeps_execution_denied_until_host_initialization_finishes() {
    let fixture = Fixture::new(
        controlled_policy(json!({"evaluate":true})),
        Some(
            "export default async c=>{c.holo.engineGate(r=>r.entryDetail?.source==='inspector'?{action:'allow'}:{action:'deny',reasonCode:'host.denied'});await new Promise(resolve=>setTimeout(resolve,1200));}",
        ),
    );
    fs::write(
        fixture.root.join("entry.mjs"),
        "console.log('EARLY_RESUME_ENTRY');",
    )
    .unwrap();
    let (mut child, input) = fixture.spawn_wait(6000);
    let mut stream = fixture.connect();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    assert!(
        command(&mut stream, &mut reader, 1, "Runtime.enable", json!({}))
            .get("result")
            .is_some()
    );
    assert!(
        command(
            &mut stream,
            &mut reader,
            2,
            "Runtime.runIfWaitingForDebugger",
            json!({})
        )
        .get("result")
        .is_some()
    );
    let (send, receive) = mpsc::channel();
    let stdout = child.stdout.take().unwrap();
    let reader_thread = std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line);
        let _ = send.send((result, line));
    });
    let early = command(
        &mut stream,
        &mut reader,
        3,
        "Runtime.evaluate",
        json!({"expression":"globalThis.earlyEscape=true;42"}),
    );
    assert_eq!(
        early.pointer("/error/code").and_then(Value::as_i64),
        Some(-32000),
        "{early}"
    );
    assert!(matches!(receive.try_recv(), Err(mpsc::TryRecvError::Empty)));
    let (read, line) = receive.recv_timeout(Duration::from_secs(4)).unwrap();
    assert!(read.unwrap() > 0, "Guest entry produced no output");
    assert!(line.contains("EARLY_RESUME_ENTRY"), "{line}");
    reader_thread.join().unwrap();
    let later = command(
        &mut stream,
        &mut reader,
        4,
        "Runtime.evaluate",
        json!({"expression":"globalThis.earlyEscape===true ? 0 : 42"}),
    );
    assert_eq!(
        later
            .pointer("/result/result/value")
            .and_then(Value::as_i64),
        Some(42),
        "{later}"
    );
    drop(reader);
    drop(stream);
    let status = wait_for_exit(&mut child, Duration::from_secs(2));
    assert!(status.success(), "{status}");
    drop(input);
}

#[test]
fn owner_eof_cancels_waiting_guest_before_entry() {
    let fixture = Fixture::new(controlled_policy(json!({})), None);
    let (mut child, input) = fixture.spawn_wait(6000);
    let mut stream = fixture.connect();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    assert!(
        command(&mut stream, &mut reader, 1, "Runtime.enable", json!({}))
            .get("result")
            .is_some()
    );
    drop(input);
    let status = wait_for_exit(&mut child, Duration::from_secs(2));
    assert!(!status.success());
    let mut output = String::new();
    use std::io::Read;
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert!(!output.contains("INSPECTOR_ENTRY"), "{output}");
    drop(reader);
    drop(stream);
    assert!(!fixture.socket.exists());
}

#[test]
fn deadline_cancels_waiting_guest_before_entry() {
    let fixture = Fixture::new(controlled_policy(json!({})), None);
    let (mut child, input) = fixture.spawn_wait(2000);
    let mut stream = fixture.connect();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    assert!(
        command(&mut stream, &mut reader, 1, "Runtime.enable", json!({}))
            .get("result")
            .is_some()
    );
    let status = wait_for_exit(&mut child, Duration::from_secs(3));
    assert!(!status.success());
    let mut output = String::new();
    use std::io::Read;
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert!(!output.contains("INSPECTOR_ENTRY"), "{output}");
    drop(input);
    drop(reader);
    drop(stream);
    assert!(!fixture.socket.exists());
}

fn paused_inspector_loop_cancels(cancel_by_owner_eof: bool) {
    let fixture = Fixture::new(controlled_policy(json!({})), None);
    let (mut child, input) = fixture.spawn_wait(if cancel_by_owner_eof { 6000 } else { 3000 });
    let mut input = Some(input);
    let mut stream = fixture.connect();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    assert!(
        command(&mut stream, &mut reader, 1, "Runtime.enable", json!({}))
            .get("result")
            .is_some()
    );
    assert!(
        command(
            &mut stream,
            &mut reader,
            2,
            "Runtime.runIfWaitingForDebugger",
            json!({})
        )
        .get("result")
        .is_some()
    );
    let (send, receive) = mpsc::channel();
    let stdout = child.stdout.take().unwrap();
    let reader_thread = std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line);
        let _ = send.send((result, line));
    });
    let (read, line) = receive.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(
        read.unwrap() > 0 && line.contains("INSPECTOR_ENTRY"),
        "{line}"
    );
    reader_thread.join().unwrap();
    assert!(
        command(&mut stream, &mut reader, 3, "Debugger.enable", json!({}))
            .get("result")
            .is_some()
    );
    stream
        .write_all(b"{\"id\":4,\"method\":\"Debugger.pause\",\"params\":{}}\n")
        .unwrap();
    let mut saw_pause = false;
    let mut saw_response = false;
    for _ in 0..128 {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        let message: Value = serde_json::from_str(&line).unwrap();
        saw_pause |= message.get("method").and_then(Value::as_str) == Some("Debugger.paused");
        saw_response |= message.get("id").and_then(Value::as_i64) == Some(4);
        if saw_pause && saw_response {
            break;
        }
    }
    assert!(saw_pause && saw_response);
    if cancel_by_owner_eof {
        drop(input.take());
    }
    let status = wait_for_exit(&mut child, Duration::from_secs(4));
    assert!(!status.success());
    drop(input);
    drop(reader);
    drop(stream);
    assert!(!fixture.socket.exists());
}

#[test]
fn owner_eof_cancels_a_paused_inspector_loop() {
    paused_inspector_loop_cancels(true);
}

#[test]
fn deadline_cancels_a_paused_inspector_loop() {
    paused_inspector_loop_cancels(false);
}

#[test]
fn real_v8_session_denies_execution_without_inspector_policy() {
    let fixture = Fixture::new(controlled_policy(json!({})), None);
    let mut child = fixture.spawn();
    let mut stream = fixture.connect();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert!(ready.contains("INSPECTOR_ENTRY"), "{ready}");
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let enabled = command(&mut stream, &mut reader, 1, "Runtime.enable", json!({}));
    assert!(enabled.get("result").is_some(), "{enabled}");
    let no_wait = command(
        &mut stream,
        &mut reader,
        99,
        "Runtime.runIfWaitingForDebugger",
        json!({}),
    );
    assert!(no_wait.get("result").is_some(), "{no_wait}");
    let isolate = command(
        &mut stream,
        &mut reader,
        2,
        "Runtime.getIsolateId",
        json!({}),
    );
    assert!(
        isolate
            .pointer("/result/id")
            .and_then(Value::as_str)
            .is_some(),
        "{isolate}"
    );
    let denied = command(
        &mut stream,
        &mut reader,
        3,
        "Runtime.evaluate",
        json!({"expression":"globalThis.escape=true"}),
    );
    assert_eq!(
        denied.pointer("/error/code").and_then(Value::as_i64),
        Some(-32000)
    );
    let conditional_breakpoint = command(
        &mut stream,
        &mut reader,
        4,
        "Debugger.setBreakpointByUrl",
        json!({"url":"app://workspace/entry.mjs","lineNumber":0,"condition":"globalThis.escape=true"}),
    );
    assert_eq!(
        conditional_breakpoint
            .pointer("/error/code")
            .and_then(Value::as_i64),
        Some(-32000)
    );
    drop(reader);
    drop(stream);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!fixture.socket.exists());
}

#[test]
fn inspector_policy_alone_cannot_authorize_execution() {
    let fixture = Fixture::new(controlled_policy(json!({"evaluate":true})), None);
    let mut child = fixture.spawn();
    let mut stream = fixture.connect();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert!(ready.contains("INSPECTOR_ENTRY"), "{ready}");
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    assert!(
        command(&mut stream, &mut reader, 1, "Runtime.enable", json!({}))
            .get("result")
            .is_some()
    );
    let denied = command(
        &mut stream,
        &mut reader,
        2,
        "Runtime.evaluate",
        json!({"expression":"globalThis.escape=true"}),
    );
    assert_eq!(
        denied.pointer("/error/code").and_then(Value::as_i64),
        Some(-32000)
    );
    drop(reader);
    drop(stream);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn client_source_url_cannot_supply_authoritative_gate_origin() {
    let fixture = Fixture::new(
        controlled_policy(json!({"compileScript":true,"runScript":true})),
        Some(
            "export default c=>{c.holo.engineGate(r=>r.origin==='app://workspace/trusted.mjs'?{action:'allow'}:{action:'deny',reasonCode:'host.untrusted_origin'});};",
        ),
    );
    let mut child = fixture.spawn();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    let mut stream = fixture.connect();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    command(&mut stream, &mut reader, 1, "Runtime.enable", json!({}));
    let denied = command(
        &mut stream,
        &mut reader,
        2,
        "Runtime.compileScript",
        json!({
            "expression":"globalThis.originSpoofExecuted=true;42", "persistScript":true,
            "sourceURL":"app://workspace/trusted.mjs"
        }),
    );
    drop(reader);
    drop(stream);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(denied["error"]["code"], -32000, "{denied}");
    assert!(denied.pointer("/result/scriptId").is_none());
}

#[test]
fn inspector_source_reader_uses_the_selected_private_byte_channel() {
    let mut policy = controlled_policy(json!({"evaluate":true}));
    policy["diagnostics"] = json!({
        "sourceReader":"boundedSource", "maxSourceReadBytes":24,
        "observerEvents":[], "maxQueuedEvents":0, "maxObserverCallbackMs":1,
        "retentionMs":0
    });
    let fixture = Fixture::new(
        policy,
        Some(
            "export default c=>{c.holo.engineGate(async r=>{if(r.entryDetail?.source!=='inspector'||r.sourceReader==null||r.sourcePrefix!==undefined)return {action:'deny',reasonCode:'host.reader_missing'};const bytes=await r.sourceReader.read({maxBytes:99});return bytes.length===12&&new TextDecoder().decode(bytes)==='globalThis.s'?{action:'allow'}:{action:'deny',reasonCode:'host.reader_wrong'};});}",
        ),
    );
    let config_path = fixture.root.join("host.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["diagnosticSourceReader"] = json!({
        "capabilityName":"host.diagnostics.source.read", "maxReadBytes":12,"maxReads":1
    });
    fs::write(&config_path, config.to_string()).unwrap();
    let mut child = fixture.spawn();
    let mut stream = fixture.connect();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert!(ready.contains("INSPECTOR_ENTRY"), "{ready}");
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    assert!(
        command(&mut stream, &mut reader, 1, "Runtime.enable", json!({}))
            .get("result")
            .is_some()
    );
    let evaluated = command(
        &mut stream,
        &mut reader,
        2,
        "Runtime.evaluate",
        json!({"expression":"globalThis.stopInspector=true; 6*7"}),
    );
    assert_eq!(
        evaluated
            .pointer("/result/result/value")
            .and_then(Value::as_i64),
        Some(42),
        "{evaluated}"
    );
    drop(reader);
    drop(stream);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn inspector_socket_rejects_a_directory_visible_to_other_users() {
    let fixture = Fixture::new(controlled_policy(json!({})), None);
    let public = fixture.root.join("public");
    fs::create_dir(&public).unwrap();
    fs::set_permissions(&public, fs::Permissions::from_mode(0o755)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args([
            "--timeout",
            "1000",
            "--host-config",
            "host.json",
            "--inspector-socket",
        ])
        .arg(public.join("cdp.sock"))
        .arg("entry.mjs")
        .current_dir(&fixture.root)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("owner-private"));
    assert!(!public.join("cdp.sock").exists());
}

#[test]
fn debugger_pause_loop_accepts_resume_on_the_guest_engine_thread() {
    let fixture = Fixture::new(controlled_policy(json!({})), None);
    let mut child = fixture.spawn();
    let mut stream = fixture.connect();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert!(ready.contains("INSPECTOR_ENTRY"), "{ready}");
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    assert!(
        command(&mut stream, &mut reader, 1, "Runtime.enable", json!({}))
            .get("result")
            .is_some()
    );
    assert!(
        command(&mut stream, &mut reader, 2, "Debugger.enable", json!({}))
            .get("result")
            .is_some()
    );
    stream
        .write_all(b"{\"id\":3,\"method\":\"Debugger.pause\",\"params\":{}}\n")
        .unwrap();
    let mut saw_pause = false;
    let mut saw_response = false;
    for _ in 0..128 {
        let mut line = String::new();
        assert!(
            reader.read_line(&mut line).unwrap() > 0,
            "Debugger disconnected before pause"
        );
        let message: Value = serde_json::from_str(&line).unwrap();
        saw_pause |= message.get("method").and_then(Value::as_str) == Some("Debugger.paused");
        saw_response |= message.get("id").and_then(Value::as_i64) == Some(3);
        if saw_pause && saw_response {
            break;
        }
    }
    assert!(
        saw_pause && saw_response,
        "V8 did not enter the paused loop"
    );
    assert!(
        command(&mut stream, &mut reader, 4, "Debugger.resume", json!({}))
            .get("result")
            .is_some()
    );
    drop(reader);
    drop(stream);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn real_v8_execution_requires_inspector_policy_and_host_engine_gate() {
    let fixture = Fixture::new(
        controlled_policy(
            json!({"evaluate":true,"compileScript":true,"runScript":true,"callFunctionOn":true}),
        ),
        Some(
            "export default c => { c.holo.engineGate(r => r.entryDetail?.source === 'inspector' && r.metadataSupport.entryDetail === 'exact' ? {action:'allow'} : {action:'deny',reasonCode:'host.user_denied'}) }",
        ),
    );
    let mut child = fixture.spawn();
    let mut stream = fixture.connect();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert!(ready.contains("INSPECTOR_ENTRY"), "{ready}");
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let enabled = command(&mut stream, &mut reader, 1, "Runtime.enable", json!({}));
    assert!(enabled.get("result").is_some(), "{enabled}");
    let hidden = command(
        &mut stream,
        &mut reader,
        2,
        "Runtime.evaluate",
        json!({"expression":"typeof __holoControlHost + '/' + typeof __holoBootstrap"}),
    );
    assert_eq!(
        hidden
            .pointer("/result/result/value")
            .and_then(Value::as_str),
        Some("undefined/undefined"),
        "{hidden}"
    );
    let compiled = command(
        &mut stream,
        &mut reader,
        3,
        "Runtime.compileScript",
        json!({"expression":"6*7","sourceURL":"app://workspace/cdp.mjs","persistScript":true}),
    );
    let script_id = compiled
        .pointer("/result/scriptId")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{compiled}"));
    let ran = command(
        &mut stream,
        &mut reader,
        4,
        "Runtime.runScript",
        json!({"scriptId":script_id}),
    );
    assert_eq!(
        ran.pointer("/result/result/value").and_then(Value::as_i64),
        Some(42),
        "{ran}"
    );
    let object = command(
        &mut stream,
        &mut reader,
        5,
        "Runtime.evaluate",
        json!({"expression":"({value:1})"}),
    );
    let object_id = object
        .pointer("/result/result/objectId")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("{object}"));
    let called = command(
        &mut stream,
        &mut reader,
        6,
        "Runtime.callFunctionOn",
        json!({"objectId":object_id,"functionDeclaration":"function(){return this.value+41}"}),
    );
    assert_eq!(
        called
            .pointer("/result/result/value")
            .and_then(Value::as_i64),
        Some(42),
        "{called}"
    );
    let evaluated = command(
        &mut stream,
        &mut reader,
        7,
        "Runtime.evaluate",
        json!({"expression":"globalThis.stopInspector=true; 6*7"}),
    );
    assert_eq!(
        evaluated
            .pointer("/result/result/value")
            .and_then(Value::as_i64),
        Some(42),
        "{evaluated}"
    );
    drop(reader);
    drop(stream);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!fixture.socket.exists());
}
