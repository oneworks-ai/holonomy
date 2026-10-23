#![cfg(target_os = "macos")]

use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}
impl Helper {
    fn new() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
            .arg("__process_io_v1")
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Self {
            stdin: Some(child.stdin.take().unwrap()),
            stdout: BufReader::new(child.stdout.take().unwrap()),
            child,
        }
    }
    fn call(&mut self, request: Value) -> Value {
        writeln!(self.stdin.as_mut().unwrap(), "{request}").unwrap();
        self.stdin.as_mut().unwrap().flush().unwrap();
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        assert!(!line.is_empty(), "private worker response");
        serde_json::from_str(&line).unwrap()
    }
    fn install(&mut self) {
        let receipt = self.call(json!({"schemaVersion":1,"kind":"install","generation":1,"profile":profile(),"policy":policy()}));
        assert_eq!(receipt["value"]["installed"], true, "{receipt}");
    }
    fn poll(&mut self) -> Vec<Value> {
        self.call(json!({"schemaVersion":1,"kind":"poll","generation":1,"maxEvents":64}))["value"]["events"]
            .as_array().unwrap().clone()
    }
}
impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn profile() -> Value {
    json!({
        "profile":"process-profile-v1",
        "backend":{"backendId":"native.darwin-seatbelt-v1","configuration":{"runtimeReadPaths":["/usr/lib"],"sandboxExecutablePath":"/usr/bin/sandbox-exec"}},
        "environment":{"allowedScopes":["processTree"],"defaultScope":"processTree","capabilityBridge":{"domains":[]}},
        "defaultShellExecutableId":"shell",
        "executables":[
            {"executableId":"echo","executable":{"kind":"hostPath","path":"/bin/echo"},"fixedArgs":[],"shell":false},
            {"executableId":"cat","executable":{"kind":"hostPath","path":"/bin/cat"},"fixedArgs":[],"shell":false},
            {"executableId":"sleep","executable":{"kind":"hostPath","path":"/bin/sleep"},"fixedArgs":[],"shell":false},
            {"executableId":"yes","executable":{"kind":"hostPath","path":"/usr/bin/yes"},"fixedArgs":[],"shell":false},
            {"executableId":"shell","executable":{"kind":"hostPath","path":"/bin/bash"},"fixedArgs":[],"shell":true}
        ]
    })
}
fn policy() -> Value {
    json!({
        "access":"sandboxed",
        "environment":{"allowedNames":[],"maxValueBytes":1024},
        "executables":[
            {"executableId":"echo","argumentBytes":65536},
            {"executableId":"cat","argumentBytes":65536},
            {"executableId":"sleep","argumentBytes":65536},
            {"executableId":"yes","argumentBytes":65536},
            {"executableId":"shell","argumentBytes":65536}
        ],
        "limits":{"maxConcurrentProcesses":4,"maxExecutionTimeMs":5000,"maxOpenPipes":12,"maxProcessTreeDepth":2,"maxStderrBytes":65536,"maxStdinBytes":65536,"maxStdoutBytes":65536,"maxTotalProcesses":16,"maxWritableRootfsBytes":0},
        "mounts":[],"network":{"access":"none"},"shell":{"access":"restricted","executableId":"shell"}
    })
}
fn spawn(id: &str, args: &[&str], resource: &str) -> Value {
    json!({"schemaVersion":1,"kind":"spawn","generation":1,"executableId":id,"args":args,"env":{},"stdio":["pipe","pipe","pipe"],"limits":policy()["limits"],"processResourceId":resource})
}
fn collect_until_close(helper: &mut Helper, handle: &str) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut found = Vec::new();
    while Instant::now() < deadline {
        found.extend(
            helper
                .poll()
                .into_iter()
                .filter(|event| event["handle"] == handle),
        );
        if found.iter().any(|event| event["kind"] == "close") {
            return found;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("job did not close: {found:?}");
}

#[test]
fn seatbelt_worker_runs_async_sync_stdio_and_enforces_installed_locator() {
    let mut helper = Helper::new();
    helper.install();
    assert_eq!(helper.call(json!({"schemaVersion":1,"kind":"install","generation":1,"profile":profile(),"policy":policy()}))["value"]["installed"], true);
    let mut altered = policy();
    altered["limits"]["maxTotalProcesses"] = json!(15);
    assert_eq!(helper.call(json!({"schemaVersion":1,"kind":"install","generation":1,"profile":profile(),"policy":altered}))["code"], "generation");

    let echoed = helper.call(spawn("echo", &["native-async"], "process-1"));
    assert_eq!(echoed["ok"], true, "{echoed}");
    let handle = echoed["value"]["handle"].as_str().unwrap();
    let events = collect_until_close(&mut helper, handle);
    assert_eq!(events.first().unwrap()["kind"], "spawn");
    assert!(
        events
            .iter()
            .any(|event| event["kind"] == "stdout" && event["base64"] == "bmF0aXZlLWFzeW5jCg=="),
        "{events:?}"
    );
    let exit = events
        .iter()
        .position(|event| event["kind"] == "exit")
        .unwrap();
    let close = events
        .iter()
        .position(|event| event["kind"] == "close")
        .unwrap();
    assert!(exit < close, "{events:?}");
    assert_eq!(helper.call(json!({"schemaVersion":1,"kind":"signal","generation":1,"handle":handle,"signal":"SIGKILL"}))["ok"], true);
    assert_eq!(
        helper.call(
            json!({"schemaVersion":1,"kind":"destroy","generation":1,"handle":handle,"index":1})
        )["ok"],
        true
    );
    assert_eq!(helper.call(json!({"schemaVersion":1,"kind":"signal","generation":1,"handle":"job-999999","signal":"SIGKILL"}))["code"], "generation");

    let cat = helper.call(spawn("cat", &[], "process-2"));
    let handle = cat["value"]["handle"].as_str().unwrap();
    let written = helper.call(json!({"schemaVersion":1,"kind":"write","generation":1,"handle":handle,"base64":"Y2F0LW9r","callbackId":7}));
    assert_eq!(written["value"]["accepted"], true, "{written}");
    assert_eq!(
        helper.call(
            json!({"schemaVersion":1,"kind":"end","generation":1,"handle":handle,"callbackId":8})
        )["ok"],
        true
    );
    let events = collect_until_close(&mut helper, handle);
    assert!(
        events.iter().any(|event| event["kind"] == "stdinCallback"
            && event["callbackId"] == 7
            && event["code"].is_null()),
        "{events:?}"
    );
    assert!(
        events.iter().any(|event| event["kind"] == "stdinCallback"
            && event["callbackId"] == 8
            && event["code"].is_null()),
        "{events:?}"
    );
    assert!(
        events
            .iter()
            .any(|event| event["kind"] == "stdout" && event["base64"] == "Y2F0LW9r"),
        "{events:?}"
    );

    let sync = helper.call(json!({"schemaVersion":1,"kind":"spawnSync","generation":1,"executableId":"echo","args":["native-sync"],"env":{},"stdio":["pipe","pipe","pipe"],"limits":policy()["limits"],"processResourceId":"sync-1-1","timeout":1000,"maxBuffer":65536,"encoding":"buffer"}));
    assert_eq!(sync["value"]["stdoutBase64"], "bmF0aXZlLXN5bmMK", "{sync}");
    assert_eq!(sync["value"]["status"], 0);
    let denied = helper.call(json!({"schemaVersion":1,"kind":"spawn","generation":1,"executableId":"echo","hostPath":"/bin/sh","args":[],"env":{},"stdio":["pipe","pipe","pipe"],"limits":policy()["limits"],"processResourceId":"process-4"}));
    assert_eq!(denied["code"], "invalid", "{denied}");
    let shell = helper.call(spawn(
        "shell",
        &["-c", "printf shell-ok; /bin/echo escaped"],
        "process-5",
    ));
    let shell_events = collect_until_close(&mut helper, shell["value"]["handle"].as_str().unwrap());
    let stdout = shell_events
        .iter()
        .filter(|event| event["kind"] == "stdout")
        .map(|event| event["base64"].as_str().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("");
    assert!(
        stdout.contains("c2hlbGwtb2s="),
        "shell builtin output: {shell_events:?}"
    );
    assert!(
        !stdout.contains("ZXNjYXBlZA=="),
        "external descendant escaped Seatbelt: {shell_events:?}"
    );
    let closed = helper.call(json!({"schemaVersion":1,"kind":"close","generation":1}));
    assert_eq!(closed["value"], json!({}));
    assert_eq!(
        helper.call(json!({"schemaVersion":1,"kind":"close","generation":1}))["value"],
        json!({})
    );
    assert_eq!(
        helper.call(spawn("echo", &["late"], "process-6"))["code"],
        "generation"
    );
}

#[test]
fn seatbelt_worker_terminates_output_above_policy_limit() {
    let mut helper = Helper::new();
    helper.install();
    let child = helper.call(spawn("yes", &[], "process-1"));
    assert_eq!(child["ok"], true, "{child}");
    let events = collect_until_close(&mut helper, child["value"]["handle"].as_str().unwrap());
    assert!(
        events
            .iter()
            .any(|event| event["kind"] == "close" && event["signal"] == "SIGKILL"),
        "{events:?}"
    );
    let output = events
        .iter()
        .filter(|event| event["kind"] == "stdout")
        .count();
    assert!(
        output >= 17,
        "breaching chunk must reach shared quota sink: {output}"
    );
}

#[test]
fn seatbelt_worker_accepts_policy_sized_chunked_stdin_with_final_callback() {
    let mut helper = Helper::new();
    let mut selected_policy = policy();
    selected_policy["limits"]["maxStdinBytes"] = json!(16 * 1024 * 1024);
    selected_policy["limits"]["maxExecutionTimeMs"] = json!(10_000);
    assert_eq!(helper.call(json!({"schemaVersion":1,"kind":"install","generation":1,"profile":profile(),"policy":selected_policy}))["ok"], true);
    let spawned = helper.call(json!({"schemaVersion":1,"kind":"spawn","generation":1,"executableId":"cat","args":[],"env":{},"stdio":["pipe","ignore","ignore"],"limits":selected_policy["limits"],"processResourceId":"process-1"}));
    let handle = spawned["value"]["handle"].as_str().unwrap().to_owned();
    let chunk = format!("{}eA==", "eHh4".repeat(87_381)); // 256 KiB of 'x'
    for index in 0..64 {
        let callback_id = if index == 63 { Some(81) } else { None };
        let receipt = helper.call(json!({"schemaVersion":1,"kind":"write","generation":1,"handle":handle,"base64":chunk,"callbackId":callback_id}));
        assert_eq!(receipt["ok"], true, "chunk {index}: {receipt}");
    }
    assert_eq!(
        helper.call(
            json!({"schemaVersion":1,"kind":"end","generation":1,"handle":handle,"callbackId":82})
        )["ok"],
        true
    );
    let events = collect_until_close(&mut helper, &handle);
    assert!(
        events.iter().any(|event| event["kind"] == "stdinCallback"
            && event["callbackId"] == 81
            && event["code"].is_null()),
        "{events:?}"
    );
    assert!(
        events.iter().any(|event| event["kind"] == "stdinCallback"
            && event["callbackId"] == 82
            && event["code"].is_null()),
        "{events:?}"
    );
}

#[test]
fn starved_poll_preserves_terminal_events_and_stdin_callback_identity() {
    use std::collections::HashSet;
    let mut helper = Helper::new();
    let mut selected_policy = policy();
    selected_policy["limits"]["maxExecutionTimeMs"] = json!(20_000);
    selected_policy["limits"]["maxTotalProcesses"] = json!(4);
    assert_eq!(helper.call(json!({"schemaVersion":1,"kind":"install","generation":1,"profile":profile(),"policy":selected_policy}))["ok"], true);
    let mut handles = Vec::new();
    for index in 0..4 {
        let spawned = helper.call(json!({"schemaVersion":1,"kind":"spawn","generation":1,"executableId":"cat","args":[],"env":{},"stdio":["pipe","ignore","ignore"],"limits":selected_policy["limits"],"processResourceId":format!("process-{}",index+1)}));
        assert_eq!(spawned["ok"], true, "{spawned}");
        handles.push(spawned["value"]["handle"].as_str().unwrap().to_owned());
    }
    // Do not poll while 512 zero-byte writes (each with a callback) arrive.
    // The helper must pause flushing instead of dropping callback/close events.
    for callback_id in 1..=128 {
        for handle in &handles {
            let queued = helper.call(json!({"schemaVersion":1,"kind":"write","generation":1,"handle":handle,"base64":"","callbackId":callback_id}));
            assert_eq!(queued["ok"], true, "{queued}");
        }
    }
    for (index, handle) in handles.iter().enumerate() {
        let command = if index == 0 {
            json!({"schemaVersion":1,"kind":"destroy","generation":1,"handle":handle,"index":0})
        } else {
            json!({"schemaVersion":1,"kind":"end","generation":1,"handle":handle,"callbackId":300})
        };
        assert_eq!(helper.call(command)["ok"], true);
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut events = Vec::new();
    while Instant::now() < deadline {
        events.extend(helper.poll());
        if events
            .iter()
            .filter(|event| event["kind"] == "close")
            .count()
            == 4
        {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    let mut callbacks = HashSet::new();
    for event in events
        .iter()
        .filter(|event| event["kind"] == "stdinCallback")
    {
        let key = (
            event["handle"].as_str().unwrap().to_owned(),
            event["callbackId"].as_u64().unwrap(),
        );
        assert!(callbacks.insert(key), "duplicate stdin callback: {event}");
    }
    for (index, handle) in handles.iter().enumerate() {
        assert_eq!(
            events
                .iter()
                .filter(|event| event["kind"] == "close"
                    && event["handle"].as_str() == Some(handle.as_str()))
                .count(),
            1,
            "close missing/duplicate for {handle}"
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event["kind"] == "stdinClose"
                    && event["handle"].as_str() == Some(handle.as_str()))
                .count(),
            1,
            "stdin close missing/duplicate for {handle}"
        );
        if index == 0 {
            assert!(events.iter().any(|event| event["kind"] == "stdinError"
                && event["handle"].as_str() == Some(handle.as_str())
                && event["code"] == "EIO"));
        } else {
            for callback_id in 1..=128 {
                assert!(
                    callbacks.contains(&(handle.clone(), callback_id)),
                    "missing callback {callback_id} for {handle}"
                );
            }
            assert!(
                callbacks.contains(&(handle.clone(), 300)),
                "missing end callback for {handle}"
            );
        }
    }
}

#[test]
fn seatbelt_worker_timeout_and_owner_eof_kill_owned_job() {
    let mut helper = Helper::new();
    helper.install();
    let timeout = helper.call(json!({"schemaVersion":1,"kind":"spawnSync","generation":1,"executableId":"sleep","args":["2"],"env":{},"stdio":["ignore","pipe","pipe"],"limits":policy()["limits"],"processResourceId":"sync-1-1","timeout":40,"maxBuffer":65536,"encoding":"buffer"}));
    assert_eq!(timeout["value"]["errorCode"], "ETIMEDOUT", "{timeout}");
    let child = helper.call(spawn("sleep", &["30"], "process-2"));
    assert_eq!(child["ok"], true, "{child}");
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut owned_pid = None;
    while Instant::now() < deadline {
        let output = Command::new("/bin/ps")
            .args(["-ax", "-o", "ppid=,pid=,command="])
            .output()
            .unwrap();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let mut parts = line.split_whitespace();
            let ppid = parts.next().and_then(|v| v.parse::<u32>().ok());
            let pid = parts.next().and_then(|v| v.parse::<i32>().ok());
            if ppid == Some(helper.child.id()) && line.contains("/bin/sleep") {
                owned_pid = pid;
                break;
            }
        }
        if owned_pid.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let pid = owned_pid.expect("helper-owned process appeared");
    helper.stdin.take();
    assert!(helper.child.wait().unwrap().success());
    let until = Instant::now() + Duration::from_secs(2);
    while Instant::now() < until && unsafe { libc::kill(pid, 0) } == 0 {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "owned process survived owner EOF"
    );
}

#[test]
fn seatbelt_worker_signals_only_its_owned_live_handle() {
    let mut helper = Helper::new();
    helper.install();
    let running = helper.call(spawn("sleep", &["30"], "process-1"));
    let handle = running["value"]["handle"].as_str().unwrap().to_owned();
    let signalled = helper.call(json!({"schemaVersion":1,"kind":"signal","generation":1,"handle":handle,"signal":"SIGTERM"}));
    assert_eq!(signalled["ok"], true, "{signalled}");
    let events = collect_until_close(&mut helper, &handle);
    assert!(
        events
            .iter()
            .any(|event| event["kind"] == "exit" && event["signal"] == "SIGTERM"),
        "{events:?}"
    );
    assert_eq!(helper.call(json!({"schemaVersion":1,"kind":"signal","generation":2,"handle":handle,"signal":"SIGKILL"}))["code"], "generation");
    assert_eq!(helper.call(json!({"schemaVersion":1,"kind":"signal","generation":1,"handle":"job-999","signal":"SIGKILL"}))["code"], "generation");
}

fn owned_process_command(pid: i32) -> Option<(i32, String)> {
    let output = Command::new("/bin/ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "ppid=,command="])
        .output()
        .ok()?;
    let line = String::from_utf8(output.stdout).ok()?;
    let mut words = line.split_whitespace();
    let ppid = words.next()?.parse().ok()?;
    Some((ppid, words.collect::<Vec<_>>().join(" ")))
}

struct RuntimeChild(Child);
impl Drop for RuntimeChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct OwnedShellCleanup {
    marker: String,
    pid: i32,
}

struct LifetimeFixture(PathBuf);
impl Drop for LifetimeFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
impl Drop for OwnedShellCleanup {
    fn drop(&mut self) {
        if owned_process_command(self.pid)
            .is_some_and(|(_, command)| command.contains(&self.marker))
        {
            unsafe {
                libc::kill(self.pid, libc::SIGKILL);
            }
        }
    }
}

#[test]
fn forced_runtime_sigkill_reaps_its_shell_job_after_owner_pipe_eof() {
    let root = std::env::temp_dir().join(format!(
        "holo-native-process-sigkill-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let _fixture = LifetimeFixture(root.clone());
    let marker = format!(
        "HOLO_OWNED_SHELL_{}_{}",
        std::process::id(),
        root.file_name().unwrap().to_string_lossy()
    );
    let host_path = root.join("host.json");
    let profile_path = root.join("process-profiles.json");
    let entry_path = root.join("entry.mjs");
    fs::write(&host_path, json!({
        "schemaVersion": 1,
        "processProfileId": "lifetime",
        "sandboxPolicy": {
            "schemaVersion": 2,
            "process": {
                "access": "sandboxed",
                "environment": {"allowedNames": [], "maxValueBytes": 1024},
                "executables": [{"executableId": "shell", "argumentBytes": 65536}],
                "limits": {"maxConcurrentProcesses": 1, "maxExecutionTimeMs": 30000, "maxOpenPipes": 3, "maxProcessTreeDepth": 2, "maxStderrBytes": 65536, "maxStdinBytes": 65536, "maxStdoutBytes": 65536, "maxTotalProcesses": 1, "maxWritableRootfsBytes": 0},
                "mounts": [], "network": {"access": "none"},
                "shell": {"access": "restricted", "executableId": "shell"}
            }
        }
    }).to_string()).unwrap();
    fs::write(&profile_path, json!({
        "schemaVersion": 1,
        "profiles": {"lifetime": {
            "profile": "process-profile-v1",
            "backend": {"backendId": "native.darwin-seatbelt-v1", "configuration": {"runtimeReadPaths": [], "sandboxExecutablePath": "/usr/bin/sandbox-exec"}},
            "defaultShellExecutableId": "shell",
            "environment": {"allowedScopes": ["processTree"], "defaultScope": "processTree"},
            "executables": [{"executableId": "shell", "executable": {"kind": "hostPath", "path": "/bin/bash"}, "fixedArgs": [], "shell": true}]
        }}
    }).to_string()).unwrap();
    fs::set_permissions(&profile_path, fs::Permissions::from_mode(0o600)).unwrap();
    let shell_script = format!("echo OWNED_PID=$$; while :; do read -t 1 _; done # {marker}");
    fs::write(&entry_path, format!(
        "import {{ spawn }} from 'node:child_process';\nconst child = spawn('shell', ['-c', {shell_script:?}]);\nchild.stdout.on('data', chunk => console.log(chunk.toString('utf8').trim()));\nchild.on('error', error => console.log('SPAWN_ERROR', error.code));\nsetInterval(() => {{}}, 1000);\n"
    )).unwrap();
    let config = holonomy_desktop_host::HostConfiguration::read(&host_path).unwrap();
    let launch = json!({
        "schemaVersion": 1,
        "generation": 1,
        "entry": entry_path.canonicalize().unwrap(),
        "argv": [],
        "timeout": 30000,
        "testMode": false,
        "hostConfig": serde_json::to_value(config).unwrap(),
        "processProfilesManifest": profile_path
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
        .arg("__runtime")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut control = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let mut runtime = RuntimeChild(child);
    writeln!(control, "{launch}").unwrap();
    control.flush().unwrap();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            if sender.send(line.unwrap_or_default()).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut messages = Vec::new();
    let owned_pid = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let line = receiver
            .recv_timeout(remaining)
            .unwrap_or_else(|_| panic!("Guest shell did not report an owned PID: {messages:?}"));
        if let Some(pid) = line
            .strip_prefix("OWNED_PID=")
            .and_then(|value| value.parse::<i32>().ok())
        {
            break pid;
        }
        messages.push(line);
    };
    let guard = OwnedShellCleanup {
        marker: marker.clone(),
        pid: owned_pid,
    };
    let runtime_pid = runtime.0.id() as i32;
    let helper_pid = {
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            let output = Command::new("/bin/ps")
                .args(["-ww", "-ax", "-o", "pid=,ppid=,command="])
                .output()
                .unwrap();
            let found = String::from_utf8_lossy(&output.stdout)
                .lines()
                .find_map(|line| {
                    let mut words = line.split_whitespace();
                    let pid = words.next()?.parse::<i32>().ok()?;
                    let ppid = words.next()?.parse::<i32>().ok()?;
                    (ppid == runtime_pid && line.contains("__process_io_v1")).then_some(pid)
                });
            if let Some(pid) = found {
                break pid;
            }
            assert!(Instant::now() < until, "owned helper was not visible");
            thread::sleep(Duration::from_millis(10));
        }
    };
    let (parent, command) = owned_process_command(owned_pid).expect("owned shell process exists");
    assert_eq!(
        parent, helper_pid,
        "shell parent must be this Runtime's helper"
    );
    assert!(
        command.contains(&marker),
        "shell command must carry unique test marker: {command}"
    );
    assert!(
        runtime.0.try_wait().unwrap().is_none(),
        "Runtime exited before forced kill"
    );
    runtime.0.kill().unwrap(); // kill only this test's Child handle; control pipe is still held here
    let until = Instant::now() + Duration::from_secs(2);
    while runtime.0.try_wait().unwrap().is_none() && Instant::now() < until {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        runtime.0.try_wait().unwrap().is_some(),
        "SIGKILL Runtime did not exit"
    );
    let until = Instant::now() + Duration::from_secs(2);
    while owned_process_command(owned_pid).is_some() && Instant::now() < until {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        unsafe { libc::kill(owned_pid, 0) },
        -1,
        "owned shell survived Runtime SIGKILL"
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    drop(guard);
    drop(control);
}
