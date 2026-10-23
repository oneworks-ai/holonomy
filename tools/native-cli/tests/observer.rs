use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-observer-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn write(&self, name: &str, source: &str) {
        fs::write(self.0.join(name), source).unwrap();
    }

    fn run(&self, plugin: &str, entry: &str, observer_events: &[&str]) -> Output {
        self.run_with_timeout(plugin, entry, observer_events, "3000")
    }

    fn run_with_timeout(
        &self,
        plugin: &str,
        entry: &str,
        observer_events: &[&str],
        timeout_ms: &str,
    ) -> Output {
        self.write("plugin.mjs", plugin);
        self.write("index.js", entry);
        let config = json!({
            "schemaVersion": 1,
            "sandboxPolicy": {
                "schemaVersion": 2,
                "diagnostics": diagnostics(observer_events),
                "codeGeneration": {
                    "strings": {
                        "access": "controlled", "decisionTimeoutMs": 1000,
                        "maxOperations": 8, "maxSourceBytes": 1024
                    },
                    "wasm": { "access": "none" },
                    "dynamicImport": { "access": "none" }
                }
            },
            "plugins": [{ "id": "observe", "use": "./plugin.mjs" }]
        });
        self.write("host.json", &config.to_string());
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--timeout",
                timeout_ms,
                "--host-config",
                "host.json",
                "index.js",
            ])
            .current_dir(&self.0)
            .env_clear()
            .env("PATH", "")
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn diagnostics(events: &[&str]) -> Value {
    json!({
        "maxObserverCallbackMs": 1000,
        "maxQueuedEvents": 32,
        "maxSourceReadBytes": 0,
        "observerEvents": events,
        "retentionMs": 0,
        "sourceReader": "none"
    })
}

fn text(output: &Output) -> (String, String) {
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn real_commonjs_compile_execute_and_terminal_events_are_host_only_and_source_free() {
    let fixture = Fixture::new();
    fixture.write("dep.cjs", "exports.value = 41\n");
    let output = fixture.run(
        r#"
          export default context => {
            const compiled = new Map(), started = new Map()
            let finished = false, safe = true
            context.holo.observe({
              acceptHighCost: true, callbackTimeoutMs: 50, maxQueuedEvents: 32,
              events: ['script.compiled', 'script.execution-started', 'script.execution-finished', 'runtime.terminated']
            }, event => {
              safe &&= Object.isFrozen(event) && Object.isFrozen(event.payload) &&
                event.generation === 1 && Number.isFinite(event.observedAt) &&
                !JSON.stringify(event).includes('SENSITIVE_GUEST_TEXT')
              if (event.event === 'script.compiled') {
                safe &&= /^[0-9a-f]{64}$/.test(event.payload.sourceSha256) && event.payload.sourceBytes > 0
                compiled.set(event.payload.scriptId, event.payload.origin)
              }
              if (event.event === 'script.execution-started') {
                started.set(event.payload.executionId, event.payload.scriptId)
              }
              if (event.event === 'script.execution-finished') {
                finished ||= started.get(event.payload.executionId) === event.payload.scriptId &&
                  compiled.get(event.payload.scriptId) === 'app://workspace/dep.cjs' &&
                  event.payload.outcome === 'completed'
              }
              if (event.event === 'runtime.terminated') throw Error('private terminal marker')
            })
            context.holo.engineGate(() => ({
              action: safe && finished && [...compiled.values()].includes('app://workspace/index.js')
                ? 'allow' : 'deny'
            }))
          }
        "#,
        r#"
          const assert = require('node:assert/strict')
          const dep = require('./dep.cjs')
          const secret = 'SENSITIVE_GUEST_TEXT'
          setTimeout(() => {
            assert.equal(dep.value + eval('1'), 42)
            console.log('NATIVE_OBSERVER_OK', secret.length)
          }, 50)
        "#,
        &["script.compiled", "script.execution-started", "script.execution-finished", "runtime.terminated"],
    );
    let (stdout, stderr) = text(&output);
    assert!(output.status.success(), "stdout={stdout} stderr={stderr}");
    assert_eq!(stdout, "NATIVE_OBSERVER_OK 20\n");
    assert!(
        stderr.contains("holo observer callback.failed runtime.terminated"),
        "{stderr}"
    );
    assert!(!stderr.contains("SENSITIVE_GUEST_TEXT"));
    assert!(!stderr.contains("private terminal marker"));
}

#[test]
fn policy_support_and_high_cost_opt_in_fail_closed_before_guest_entry() {
    let cases = [
        ("['script.compiled']", vec![]),
        ("['gc.completed']", vec!["gc.completed"]),
        ("['script.compiled']", vec!["script.compiled"]),
    ];
    for (events, policy) in cases {
        let fixture = Fixture::new();
        let plugin =
            format!("export default c => {{ c.holo.observe({{events:{events}}}, () => {{}}) }}");
        let output = fixture.run(&plugin, "console.log('GUEST_MUST_NOT_RUN')", &policy);
        let (stdout, stderr) = text(&output);
        assert!(!output.status.success(), "{stdout} {stderr}");
        assert!(!stdout.contains("GUEST_MUST_NOT_RUN"));
        assert!(
            stderr.contains("Host Runtime initialization failed"),
            "{stderr}"
        );
    }
}

#[test]
fn throw_timeout_and_overflow_do_not_block_guest_or_engine_authorization() {
    let fixture = Fixture::new();
    for index in 0..12 {
        fixture.write(&format!("dep{index}.cjs"), "exports.value = 1\n");
    }
    let requires = (0..12)
        .map(|index| format!("require('./dep{index}.cjs');"))
        .collect::<String>();
    let entry = format!(
        "{requires} setTimeout(() => {{ if (eval('40') + 2 !== 42) throw Error('gate failed'); console.log('OBSERVER_ISOLATED_OK'); }}, 120);"
    );
    let output = fixture.run(
        r#"
          export default context => {
            let calls = 0
            context.holo.observe({
              acceptHighCost: true, callbackTimeoutMs: 20, maxQueuedEvents: 1,
              events: ['script.compiled', 'script.execution-started', 'script.execution-finished']
            }, () => {
              if (++calls === 1) throw Error('private observer throw')
              if (calls === 2) return new Promise(() => {})
            })
            context.holo.engineGate(() => ({ action: 'allow' }))
          }
        "#,
        &entry,
        &[
            "script.compiled",
            "script.execution-started",
            "script.execution-finished",
        ],
    );
    let (stdout, stderr) = text(&output);
    assert!(output.status.success(), "stdout={stdout} stderr={stderr}");
    assert_eq!(stdout, "OBSERVER_ISOLATED_OK\n");
    assert!(stderr.contains("holo observer callback.failed"), "{stderr}");
    assert!(
        stderr.contains("holo observer callback.timeout"),
        "{stderr}"
    );
    assert!(stderr.contains("holo observer event.dropped"), "{stderr}");
    assert!(!stderr.contains("private observer throw"));
}

#[test]
fn never_resolving_observer_does_not_hold_guest_terminal_open() {
    let fixture = Fixture::new();
    let output = fixture.run_with_timeout(
        r#"
          export default context => {
            context.holo.observe({
              acceptHighCost: true, callbackTimeoutMs: 1000,
              events: ['script.compiled']
            }, () => new Promise(() => {}))
          }
        "#,
        "console.log('OBSERVER_NONBLOCKING_TERMINAL_OK')",
        &["script.compiled"],
        "500",
    );
    let (stdout, stderr) = text(&output);
    assert!(output.status.success(), "stdout={stdout} stderr={stderr}");
    assert_eq!(stdout, "OBSERVER_NONBLOCKING_TERMINAL_OK\n");
}

#[test]
fn thrown_guest_exception_produces_stable_exception_and_failed_terminal() {
    let fixture = Fixture::new();
    let output = fixture.run(
        r#"
          export default context => {
            context.holo.observe({
              events: ['runtime.exception', 'runtime.terminated']
            }, event => {
              if (event.event === 'runtime.exception' && event.payload.code === 'runtime.execution_failed') {
                throw Error('private exception marker')
              }
              if (event.event === 'runtime.terminated' && event.payload.reason === 'failed') {
                throw Error('private failed marker')
              }
            })
          }
        "#,
        "throw Error('GUEST_ERROR_MARKER')",
        &["runtime.exception", "runtime.terminated"],
    );
    let (_stdout, stderr) = text(&output);
    assert!(!output.status.success());
    assert!(
        stderr.contains("holo observer callback.failed runtime.exception"),
        "{stderr}"
    );
    assert!(
        stderr.contains("holo observer callback.failed runtime.terminated"),
        "{stderr}"
    );
    assert!(!stderr.contains("private exception marker"));
    assert!(!stderr.contains("private failed marker"));
}
