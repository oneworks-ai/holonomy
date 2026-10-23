use serde_json::json;
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
        let directory = std::env::temp_dir().join(format!(
            "holonomy-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        Self(directory)
    }
    fn write(&self, name: &str, source: &str) {
        fs::write(self.0.join(name), source).unwrap();
    }
    fn run(&self, args: &[&str]) -> Output {
        self.binary(env!("CARGO_BIN_EXE_holo"), args)
    }
    fn binary(&self, binary: &str, args: &[&str]) -> Output {
        Command::new(binary)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .current_dir(&self.0)
            .output()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}
fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}
fn success(output: &Output) {
    assert!(output.status.success(), "{}", stderr(output));
}

#[test]
fn relocated_binary_runs_index_js_without_node_or_runtime_assets() {
    let fixture = Fixture::new();
    let copy = fixture.0.join("holo");
    fs::copy(env!("CARGO_BIN_EXE_holo"), &copy).unwrap();
    fixture.write("index.js", "const assert=require('node:assert/strict'); const path=require('node:path'); assert.equal(path.basename('/a/b'),'b'); assert.equal(process.versions.node,undefined); assert.ok(process.versions.v8); console.log('native',process.argv[2]);");
    let output = fixture.binary(
        copy.to_str().unwrap(),
        &["--timeout", "3000", "index.js", "hello"],
    );
    success(&output);
    assert_eq!(stdout(&output), "native hello\n");
}

#[test]
fn executes_commonjs_cycles_and_json_through_shared_resolution() {
    let fixture = Fixture::new();
    fixture.write("index.js", "const assert=require('node:assert/strict'); const a=require('./a.cjs'); assert.equal(a.b,'b'); assert.equal(a.fromCycle,'a'); assert.equal(require('./value.json').answer,42); console.log('CYCLE_OK');");
    fixture.write(
        "a.cjs",
        "exports.name='a'; const b=require('./b.cjs'); exports.b=b.name; exports.fromCycle=b.a;",
    );
    fixture.write(
        "b.cjs",
        "exports.name='b'; exports.a=require('./a.cjs').name;",
    );
    fixture.write("value.json", "{\"answer\":42}");
    let output = fixture.run(&["--timeout", "3000", "index.js"]);
    success(&output);
    assert_eq!(stdout(&output), "CYCLE_OK\n");
}

#[test]
fn supports_package_module_type_dynamic_import_cache_and_top_level_await() {
    let fixture = Fixture::new();
    fixture.write("package.json", "{\"type\":\"module\"}");
    fixture.write("index.js", "import assert from 'node:assert/strict'; const spec='./value.mjs'; const a=await import(spec); const b=await import(spec); assert.equal(a,b); assert.equal(a.answer,42); assert.equal(import.meta.url,'app://workspace/index.js'); console.log('ESM_OK');");
    fixture.write(
        "value.mjs",
        "await new Promise(r=>setTimeout(r,5)); export const answer=42;",
    );
    let output = fixture.run(&["--timeout", "3000", "index.js"]);
    success(&output);
    assert_eq!(stdout(&output), "ESM_OK\n");
}

#[test]
fn hides_host_controller_and_denies_engine_and_native_escapes() {
    let fixture = Fixture::new();
    fixture.write("index.mjs", "import assert from 'node:assert/strict'; for(const key of ['__holoNativeHost','__holoBootstrap','require','Worker','Deno']) assert.equal(typeof globalThis[key],'undefined'); assert.equal(process.env.HOME,undefined); assert.equal(process.versions.node,undefined); assert.throws(()=>eval('globalThis.compiled=true')); assert.throws(()=>Function('return 1')); assert.throws(()=>new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))); assert.equal(globalThis.compiled,undefined); const denied='node:vm'; await assert.rejects(import(denied)); console.log('BOUNDARIES_OK');");
    let output = fixture.run(&["--timeout", "3000", "index.mjs"]);
    success(&output);
    assert_eq!(stdout(&output), "BOUNDARIES_OK\n");
}

#[test]
fn controlled_engine_gate_enters_host_context_and_fails_closed_without_a_host_binding() {
    let fixture = Fixture::new();
    fixture.write(
        "host.json",
        &json!({
            "schemaVersion": 1,
            "sandboxPolicy": {
                "schemaVersion": 2,
                "codeGeneration": {
                    "dynamicImport": { "access": "none" },
                    "strings": {
                        "access": "controlled",
                        "decisionTimeoutMs": 1,
                        "maxOperations": 8,
                        "maxSourceBytes": 1024
                    },
                    "wasm": {
                        "access": "controlled",
                        "decisionTimeoutMs": 1,
                        "maxOperations": 8,
                        "maxSourceBytes": 1024
                    }
                }
            }
        })
        .to_string(),
    );
    fixture.write(
        "entry.mjs",
        "import assert from 'node:assert/strict'; assert.throws(()=>eval('globalThis.engineEscape=true')); assert.throws(()=>Function('globalThis.engineEscape=true')()); assert.throws(()=>new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))); assert.equal(globalThis.engineEscape,undefined); console.log('ENGINE_GATE_FAIL_CLOSED_OK');",
    );
    let output = fixture.run(&[
        "--timeout",
        "3000",
        "--host-config",
        "host.json",
        "entry.mjs",
    ]);
    success(&output);
    assert_eq!(stdout(&output), "ENGINE_GATE_FAIL_CLOSED_OK\n");
}

#[test]
fn controlled_engine_gate_denies_without_executing_generated_code_or_crossing_host_context() {
    let fixture = Fixture::new();
    fixture.write(
        "host.json",
        &json!({
            "schemaVersion": 1,
            "sandboxPolicy": {
                "schemaVersion": 2,
                "codeGeneration": {
                    "dynamicImport": { "access": "none" },
                    "strings": {
                        "access": "controlled",
                        "decisionTimeoutMs": 1,
                        "maxOperations": 3,
                        "maxSourceBytes": 1024
                    },
                    "wasm": {
                        "access": "controlled",
                        "decisionTimeoutMs": 1,
                        "maxOperations": 1,
                        "maxSourceBytes": 1024
                    }
                }
            }
        })
        .to_string(),
    );
    fixture.write(
        "entry.mjs",
        "import assert from 'node:assert/strict'; assert.equal(typeof globalThis.__holoControlHost,'undefined'); assert.throws(()=>eval('globalThis.engineEscape=true')); assert.throws(()=>Function('globalThis.engineEscape=true')()); assert.throws(()=>new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))); assert.equal(globalThis.engineEscape,undefined); console.log('ENGINE_DENY_OK');",
    );
    let output = fixture.run(&[
        "--timeout",
        "3000",
        "--host-config",
        "host.json",
        "entry.mjs",
    ]);
    success(&output);
    assert_eq!(stdout(&output), "ENGINE_DENY_OK\n");
}

#[test]
fn controlled_engine_gate_rejects_oversized_and_reused_string_requests() {
    let fixture = Fixture::new();
    fixture.write(
        "host.json",
        &json!({
            "schemaVersion": 1,
            "sandboxPolicy": {
                "schemaVersion": 2,
                "codeGeneration": {
                    "dynamicImport": { "access": "none" },
                    "strings": {
                        "access": "controlled",
                        "decisionTimeoutMs": 1,
                        "maxOperations": 1,
                        "maxSourceBytes": 1
                    },
                    "wasm": {
                        "access": "controlled",
                        "decisionTimeoutMs": 1,
                        "maxOperations": 1,
                        "maxSourceBytes": 1
                    }
                }
            }
        })
        .to_string(),
    );
    fixture.write(
        "entry.mjs",
        "import assert from 'node:assert/strict'; assert.throws(()=>eval('1')); assert.throws(()=>eval('12')); assert.throws(()=>Function('return 2')()); assert.throws(()=>eval('1')); assert.throws(()=>new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))); console.log('ENGINE_LIMITS_OK');",
    );
    let output = fixture.run(&[
        "--timeout",
        "3000",
        "--host-config",
        "host.json",
        "entry.mjs",
    ]);
    success(&output);
    assert_eq!(stdout(&output), "ENGINE_LIMITS_OK\n");
}

#[test]
fn engine_gate_rejects_oversized_guest_strings_before_host_snapshotting() {
    let fixture = Fixture::new();
    fixture.write(
        "host.json",
        &json!({
            "schemaVersion": 1,
            "sandboxPolicy": {
                "schemaVersion": 2,
                "codeGeneration": {
                    "dynamicImport": { "access": "none" },
                    "strings": {
                        "access": "controlled",
                        "decisionTimeoutMs": 1000,
                        "maxOperations": 1,
                        "maxSourceBytes": 16 * 1024 * 1024
                    },
                    "wasm": { "access": "none" }
                }
            }
        })
        .to_string(),
    );
    fixture.write(
        "entry.mjs",
        "import assert from 'node:assert/strict'; const source='x'.repeat(17*1024*1024); assert.throws(()=>eval(source)); console.log('ENGINE_SNAPSHOT_BOUND_OK');",
    );
    let output = fixture.run(&[
        "--timeout",
        "5000",
        "--host-config",
        "host.json",
        "entry.mjs",
    ]);
    success(&output);
    assert_eq!(stdout(&output), "ENGINE_SNAPSHOT_BOUND_OK\n");
}

#[test]
fn rejects_workspace_symlinks_before_entry_side_effects() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let outside = Fixture::new();
    outside.write("secret.mjs", "export const secret='host-secret';");
    symlink(outside.0.join("secret.mjs"), fixture.0.join("escape.mjs")).unwrap();
    fixture.write(
        "index.mjs",
        "import './escape.mjs'; console.log('MUST_NOT_RUN');",
    );
    let output = fixture.run(&["--timeout", "3000", "index.mjs"]);
    assert!(!output.status.success());
    assert!(!stdout(&output).contains("MUST_NOT_RUN"));
    assert!(!stderr(&output).contains("host-secret"));
}

#[test]
fn maps_exit_exception_and_syntax_terminals() {
    let fixture = Fixture::new();
    fixture.write("exit.js", "process.exit(7); console.log('LATE');");
    let output = fixture.run(&["--timeout", "3000", "exit.js"]);
    assert_eq!(output.status.code(), Some(7));
    assert!(stdout(&output).is_empty());
    fixture.write("throw.js", "throw new Error('EXPECTED_FAILURE')");
    let output = fixture.run(&["--timeout", "3000", "throw.js"]);
    assert!(!output.status.success());
    assert!(stderr(&output).contains("EXPECTED_FAILURE"));
    fixture.write("syntax.js", "const = ;");
    assert!(
        !fixture
            .run(&["--timeout", "3000", "syntax.js"])
            .status
            .success()
    );
}

#[test]
fn unhandled_rejections_fail_but_handled_rejections_do_not() {
    let fixture = Fixture::new();
    fixture.write("unhandled.js", "Promise.reject(new Error('UNHANDLED'));");
    let output = fixture.run(&["--timeout", "3000", "unhandled.js"]);
    assert!(
        !output.status.success(),
        "Unhandled rejection silently succeeded"
    );
    assert!(stderr(&output).contains("UNHANDLED"));
    fixture.write(
        "handled.js",
        "Promise.reject(new Error('HANDLED')).catch(()=>{}); console.log('OK');",
    );
    success(&fixture.run(&["--timeout", "3000", "handled.js"]));
}

#[test]
fn interrupts_synchronous_and_microtask_loops() {
    let fixture = Fixture::new();
    for (name, source) in [
        ("sync.js", "while(true){}"),
        (
            "micro.js",
            "function loop(){Promise.resolve().then(loop)} loop();",
        ),
    ] {
        fixture.write(name, source);
        let output = fixture.run(&["--timeout", "250", name]);
        assert!(!output.status.success());
        assert!(stderr(&output).contains("deadline"), "{}", stderr(&output));
    }
}

#[test]
fn runs_existing_shared_js_timer_conformance() {
    let fixture = Fixture::new();
    fixture.write(
        "timers.test.mjs",
        include_str!("../../../conformance/specs/timers.test.mjs"),
    );
    let output = fixture.run(&["test", "--timeout", "3000", "timers.test.mjs"]);
    success(&output);
    let report: serde_json::Value = serde_json::from_str(stdout(&output).trim()).unwrap();
    assert_eq!(report["passed"], 4);
    assert_eq!(report["failed"], 0);
    assert_eq!(report["platform"], "desktop");
}

#[test]
fn runs_existing_shared_js_console_and_node_module_conformance_without_node() {
    let fixture = Fixture::new();
    for (name, source, passed) in [
        (
            "console.test.mjs",
            include_str!("../../../conformance/specs/console.test.mjs"),
            2,
        ),
        (
            "node-modules.test.mjs",
            include_str!("../../../conformance/specs/node-modules.test.mjs"),
            3,
        ),
    ] {
        fixture.write(name, source);
        let output = Command::new(env!("CARGO_BIN_EXE_holo"))
            .args(["test", "--timeout", "3000", name])
            .env_clear()
            .env("PATH", "")
            .current_dir(&fixture.0)
            .output()
            .unwrap();
        success(&output);
        let report = stdout(&output);
        let report: serde_json::Value =
            serde_json::from_str(report.lines().last().unwrap()).unwrap();
        assert_eq!(report["passed"], passed);
        assert_eq!(report["failed"], 0);
        assert_eq!(report["platform"], "desktop");
    }
}

#[test]
fn dynamic_import_does_not_trust_guest_json_replacement() {
    let fixture = Fixture::new();
    fixture.write("value.mjs", "export const answer=42;");
    fixture.write("index.mjs", "import assert from 'node:assert/strict'; const name='./value.mjs'; JSON.stringify=()=>{throw new Error('GUEST_STRINGIFY')}; const {answer}=await import(name); assert.equal(answer,42); console.log('FROZEN_PLAN_OK');");
    let output = fixture.run(&["--timeout", "3000", "index.mjs"]);
    success(&output);
    assert_eq!(stdout(&output), "FROZEN_PLAN_OK\n");
}

#[test]
fn unresolved_dynamic_import_has_a_terminal_without_cpu_spinning() {
    let fixture = Fixture::new();
    fixture.write("value.mjs", "await new Promise(()=>{});");
    fixture.write("index.mjs", "const name='./value.mjs'; await import(name);");
    let output = fixture.run(&["--timeout", "3000", "index.mjs"]);
    assert!(!output.status.success());
    assert!(stderr(&output).contains("Unsettled"), "{}", stderr(&output));
    assert!(!stderr(&output).contains("deadline"));
}

#[test]
fn launch_pipe_eof_cancels_owned_runtime() {
    use std::io::{BufRead, Write};
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let fixture = Fixture::new();
    fixture.write("index.js", "console.log('RUNNING'); while(true){}");
    let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
        .arg("__runtime")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut control = child.stdin.take().unwrap();
    let launch = serde_json::json!({"schemaVersion":1,"generation":1,"entry":fixture.0.join("index.js"),"argv":[],"timeout":3000,"testMode":false,"hostConfig":null});
    writeln!(control, "{launch}").unwrap();
    control.flush().unwrap();
    let mut line = String::new();
    std::io::BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line, "RUNNING\n");
    drop(control);
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        if start.elapsed() > Duration::from_secs(1) {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("Runtime ignored owner EOF");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
