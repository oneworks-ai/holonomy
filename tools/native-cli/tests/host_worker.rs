use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-worker-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("plugins")).unwrap();
        Self(root)
    }
    fn run(&self, plugin: &str, entry: &str, timeout: &str) -> Output {
        self.run_with_gate(plugin, entry, timeout, None)
    }
    fn run_with_gate(
        &self,
        plugin: &str,
        entry: &str,
        timeout: &str,
        gate_ms: Option<u64>,
    ) -> Output {
        self.prepare(plugin, entry, gate_ms);
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--timeout",
                timeout,
                "--host-config",
                "host.json",
                "entry.mjs",
            ])
            .env_clear()
            .env("PATH", "")
            .current_dir(&self.0)
            .output()
            .unwrap()
    }
    fn prepare(&self, plugin: &str, entry: &str, gate_ms: Option<u64>) {
        fs::write(self.0.join("plugins/control.mjs"), plugin).unwrap();
        fs::write(self.0.join("entry.mjs"), entry).unwrap();
        let mut configuration = json!({
            "schemaVersion":1,
            "sandboxPolicy":{"schemaVersion":2,"systemInformation":{"defaultMode":"unavailable","fields":{"os.arch":{"allowedModes":["synthetic"],"maxPrecision":"exact"}}}},
            "systemProjection":{"schemaVersion":1,"fields":{"os.arch":{"mode":"synthetic","precision":"exact","value":"arm64"}}},
            "plugins":[{"id":"control","use":"./plugins/control.mjs"}]
        });
        if let Some(timeout) = gate_ms {
            configuration["sandboxPolicy"]["codeGeneration"] = json!({"strings":{"access":"controlled","maxSourceBytes":4096,"maxOperations":16,"decisionTimeoutMs":timeout},"wasm":{"access":"none"},"dynamicImport":{"access":"none"}});
        }
        fs::write(self.0.join("host.json"), configuration.to_string()).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn text(output: &Output) -> (String, String) {
    (
        String::from_utf8_lossy(&output.stdout).into(),
        String::from_utf8_lossy(&output.stderr).into(),
    )
}

#[test]
fn host_timer_advances_while_guest_javascript_is_synchronously_busy() {
    let output = Fixture::new().run(
        r#"
      export default context => {
        globalThis.hostOnlySecret='PRIVATE';
        let armed=false,ready=false;
        context.holo.intercept({operation:'system.os.arch.read'}, (invocation,next)=>{
          if(!armed){armed=true;setTimeout(()=>{ready=true},30)}
          else if(!ready)context.holo.deny(invocation);
          return next();
        },{execution:'sync'});
      };
    "#,
        r#"
      import assert from 'node:assert/strict'; import os from 'node:os';
      assert.equal(globalThis.hostOnlySecret,undefined);
      assert.equal(globalThis.__holoControlHost,undefined);
      assert.equal(os.arch(),'arm64');
      const until=Date.now()+300;while(Date.now()<until){}
      assert.equal(os.arch(),'arm64');
      console.log('HOST_PROGRESS_DURING_GUEST_OK');
    "#,
        "5000",
    );
    let (stdout, stderr) = text(&output);
    assert!(output.status.success(), "{stdout}\n{stderr}");
    assert_eq!(stdout, "HOST_PROGRESS_DURING_GUEST_OK\n");
}

#[test]
fn asynchronous_host_initialization_finishes_before_guest_entry() {
    let output = Fixture::new().run(r#"
      export default async context => {
        await new Promise(resolve=>setTimeout(resolve,30));
        context.holo.intercept({operation:'system.os.arch.read'}, invocation=>context.holo.deny(invocation),{execution:'sync'});
      };
    "#, "import assert from 'node:assert/strict';import os from 'node:os';assert.throws(()=>os.arch(),{code:'ERR_ACCESS_DENIED'});console.log('HOST_INIT_BARRIER_OK');", "5000");
    let (stdout, stderr) = text(&output);
    assert!(output.status.success(), "{stdout}\n{stderr}");
    assert_eq!(stdout, "HOST_INIT_BARRIER_OK\n");
}

#[test]
fn deadline_interrupts_a_busy_host_isolate_and_wakes_the_guest_waiter() {
    let started = Instant::now();
    let output = Fixture::new().run(
        "export default context=>{context.holo.intercept({operation:'system.os.arch.read'},()=>{while(true){}},{execution:'sync'});};",
        "import os from 'node:os';console.log('HOST_CALL_BEGIN');os.arch();console.log('AFTER_MUST_NOT_RUN');", "1000");
    let (stdout, stderr) = text(&output);
    assert!(!output.status.success());
    assert!(stdout.contains("HOST_CALL_BEGIN"), "{stdout}\n{stderr}");
    assert!(!stdout.contains("AFTER_MUST_NOT_RUN"));
    assert!(stderr.contains("deadline"), "{stderr}");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn host_worker_failure_is_terminal_without_copying_the_host_exception() {
    let output = Fixture::new().run(
        "export default()=>{setTimeout(()=>{throw new Error('HOST_ONLY_SECRET_ERROR')},20)};",
        "await new Promise(resolve=>setTimeout(resolve,200));console.log('AFTER_MUST_NOT_RUN');",
        "3000",
    );
    let (stdout, stderr) = text(&output);
    assert!(!output.status.success());
    assert!(!stdout.contains("AFTER_MUST_NOT_RUN"));
    assert!(!stderr.contains("HOST_ONLY_SECRET_ERROR"));
    assert!(stderr.contains("Host"), "{stderr}");
}

#[test]
fn guest_callbacks_do_not_reenter_during_host_cleanup_after_entry_failure() {
    let output=Fixture::new().run(
        "export default context=>{context.on('dispose',async()=>{await new Promise(resolve=>setTimeout(resolve,50));});};",
        "setTimeout(()=>console.log('LATE_GUEST_TIMER'),0);Promise.resolve().then(()=>console.log('LATE_GUEST_MICROTASK'));throw new Error('ENTRY_FAILURE');",
        "3000");
    let (stdout, stderr) = text(&output);
    assert!(!output.status.success());
    assert!(
        stdout.is_empty(),
        "Guest reentered during cleanup: {stdout}"
    );
    assert!(stderr.contains("ENTRY_FAILURE"), "{stderr}");
}

#[test]
fn gate_uses_its_frozen_local_deadline_when_the_host_is_busy() {
    let output = Fixture::new().run_with_gate(
        r#"
      export default context => {
        context.holo.intercept({operation:'system.os.arch.read'},(invocation,next)=>{
          setTimeout(()=>{while(true){}},0);return next();
        },{execution:'sync'});
      };
    "#,
        r#"
      import assert from 'node:assert/strict'; import os from 'node:os';
      os.arch(); const wait=Date.now()+50;while(Date.now()<wait){}
      const started=Date.now();assert.throws(()=>eval('1'));
      assert.ok(Date.now()-started<200);
      console.log('GATE_LOCAL_DEADLINE_OK');
    "#,
        "5000",
        Some(20),
    );
    let (stdout, stderr) = text(&output);
    assert!(
        stdout.contains("GATE_LOCAL_DEADLINE_OK"),
        "{stdout}\n{stderr}"
    );
    assert!(!output.status.success()); // The nonresponsive Host generation is terminated.
    assert!(stderr.contains("Host worker"), "{stderr}");
}

#[test]
fn owner_eof_interrupts_the_host_worker_without_waiting_for_the_global_deadline() {
    use holonomy_desktop_host::{HostConfiguration, RuntimeLaunch};
    use std::{
        io::{BufRead, Write},
        process::Stdio,
    };
    let fixture = Fixture::new();
    fixture.prepare("export default context=>{context.holo.intercept({operation:'system.os.arch.read'},()=>{while(true){}},{execution:'sync'});};",
        "import os from 'node:os';console.log('OWNER_READY');os.arch();",None);
    let config = HostConfiguration::read(&fixture.0.join("host.json")).unwrap();
    let launch = RuntimeLaunch {
        workspace_root: None,
        module_allowlist: None,
        module_aliases: None,
        module_metadata_only: vec![],
        schema_version: 1,
        generation: 1,
        entry: fixture.0.join("entry.mjs"),
        argv: vec![],
        timeout: Some(5000),
        test_mode: false,
        host_config: Some(config),
        watch_config: None,
        service_plugin_config: None,
        process_profiles_manifest: None,
        service_plugin_revision: None,
        inspector_socket: None,
        inspector_wait_for_debugger: false,
    };
    let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
        .arg("__runtime")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "{}", launch.encode().unwrap()).unwrap();
    input.flush().unwrap();
    let mut line = String::new();
    std::io::BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line, "OWNER_READY\n");
    drop(input);
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        if started.elapsed() > Duration::from_secs(2) {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("Host worker ignored owner EOF");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
