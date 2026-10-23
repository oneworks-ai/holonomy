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
            "holo-source-reader-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn run(&self, config: Value, plugin: &str, entry: &str) -> Output {
        fs::write(self.0.join("host.json"), config.to_string()).unwrap();
        fs::write(self.0.join("plugin.mjs"), plugin).unwrap();
        fs::write(self.0.join("entry.mjs"), entry).unwrap();
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--timeout",
                "5000",
                "--host-config",
                "host.json",
                "entry.mjs",
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

fn host_config(mode: &str, selected: bool) -> Value {
    let diagnostics = json!({
        "sourceReader": mode,
        "maxSourceReadBytes": if mode == "boundedSource" { 24 } else { 0 },
        "observerEvents": [],
        "maxQueuedEvents": 0,
        "maxObserverCallbackMs": 1,
        "retentionMs": 0
    });
    let mut config = json!({
        "schemaVersion": 1,
        "sandboxPolicy": {
            "schemaVersion": 2,
            "diagnostics": diagnostics,
            "codeGeneration": {
                "strings": { "access": "controlled", "maxSourceBytes": 4096,
                    "maxOperations": 8, "decisionTimeoutMs": 1000 },
                "wasm": { "access": "none" },
                "dynamicImport": { "access": "none" }
            }
        },
        "plugins": [{ "id": "gate", "use": "./plugin.mjs" }]
    });
    if selected {
        config["diagnosticSourceReader"] = json!({
            "capabilityName": "host.diagnostics.source.read",
            "maxReadBytes": 12,
            "maxReads": 1
        });
    }
    config
}

#[test]
fn native_reader_is_host_only_bounded_one_shot_and_closed_after_gate() {
    let output = Fixture::new().run(
        host_config("boundedSource", true),
        r#"
        export default c => {
          let calls = 0, stale;
          c.holo.engineGate(async request => {
            if (++calls === 1) {
              if (!Object.isFrozen(request) || request.sourceReader == null ||
                  request.runtime.generation !== 1) return { action:'deny', reasonCode:'host.missing_reader' };
              let getterRan = false;
              const accessor = Object.defineProperty({}, 'maxBytes', {
                get() { getterRan = true; return 1; }
              });
              try { await request.sourceReader.read(accessor); } catch {}
              if (getterRan) return { action:'deny', reasonCode:'host.reader_getter' };
              try { await request.sourceReader.read({maxBytes:1,[Symbol('extra')]:true}); } catch {}
              const bytes = await request.sourceReader.read({ maxBytes: 100 });
              if (bytes.length !== 12 || new TextDecoder().decode(bytes) !== 'globalThis.r')
                return { action:'deny', reasonCode:'host.reader_content' };
              try { await request.sourceReader.read({ maxBytes: 1 });
                return { action:'deny', reasonCode:'host.reader_reuse' }; } catch {}
              stale = request.sourceReader;
              return { action:'allow' };
            }
            if (request.sourceReader !== undefined) return { action:'deny', reasonCode:'host.read_budget' };
            try { await stale.read({ maxBytes: 1 });
              return { action:'deny', reasonCode:'host.reader_late' }; } catch {}
            return { action:'allow' };
          });
        };
        "#,
        r#"
        import assert from 'node:assert/strict';
        eval('globalThis.readProof=42');
        assert.equal(globalThis.readProof, 42);
        assert.equal(eval('41+1'), 42);
        assert.equal(typeof globalThis.__holoControlHost, 'undefined');
        console.log('NATIVE_SOURCE_READER_OK');
        "#,
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stdout}\n{stderr}");
    assert!(
        stdout.contains("NATIVE_SOURCE_READER_OK"),
        "{stdout}\n{stderr}"
    );
    assert!(!stdout.contains("globalThis.readProof") && !stderr.contains("globalThis.readProof"));
}

#[test]
fn bounded_source_without_selected_capability_fails_before_guest_entry() {
    let output = Fixture::new().run(
        host_config("boundedSource", false),
        "export default c=>c.holo.engineGate(()=>({action:'allow'}));",
        "console.log('GUEST_MUST_NOT_RUN');",
    );
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("GUEST_MUST_NOT_RUN"));
}

#[test]
fn metadata_only_gate_has_no_reader() {
    let output = Fixture::new().run(
        host_config("metadataOnly", false),
        "export default c=>{c.holo.engineGate(r=>r.sourceReader===undefined?{action:'allow'}:{action:'deny',reasonCode:'host.reader_leak'});};",
        "import assert from 'node:assert/strict';assert.equal(eval('6*7'),42);console.log('METADATA_ONLY_OK');",
    );
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("METADATA_ONLY_OK"));
}

#[test]
fn wrong_capability_name_and_reader_without_policy_fail_closed() {
    let fixture = Fixture::new();
    let mut wrong = host_config("boundedSource", true);
    wrong["diagnosticSourceReader"]["capabilityName"] = json!("host.fs");
    let output = fixture.run(
        wrong,
        "export default ()=>{};",
        "console.log('GUEST_MUST_NOT_RUN');",
    );
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("GUEST_MUST_NOT_RUN"));

    let output = fixture.run(
        host_config("metadataOnly", true),
        "export default ()=>{};",
        "console.log('GUEST_MUST_NOT_RUN');",
    );
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("GUEST_MUST_NOT_RUN"));
}

#[test]
fn native_hard_cap_bounds_source_copy_below_policy_and_selection() {
    let mut config = host_config("boundedSource", true);
    config["sandboxPolicy"]["diagnostics"]["maxSourceReadBytes"] = json!(1024 * 1024);
    config["sandboxPolicy"]["codeGeneration"]["strings"]["maxSourceBytes"] = json!(200_000);
    config["diagnosticSourceReader"]["maxReadBytes"] = json!(1024 * 1024);
    let output = Fixture::new().run(
        config,
        r#"
        export default c=>{c.holo.engineGate(async r=>{
          const bytes=await r.sourceReader.read({maxBytes:1024*1024});
          return bytes.length===65536 && bytes[0]===47 && bytes[1]===42
            ? {action:'allow'} : {action:'deny',reasonCode:'host.hard_cap'};
        });};
        "#,
        "import assert from 'node:assert/strict';assert.equal(eval('/*'+'x'.repeat(70000)+'*/;42'),42);console.log('HARD_CAP_OK');",
    );
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("HARD_CAP_OK"));
}

#[test]
fn timed_out_gate_revokes_reader_and_late_allow_cannot_compile() {
    let mut config = host_config("boundedSource", true);
    config["sandboxPolicy"]["codeGeneration"]["strings"]["decisionTimeoutMs"] = json!(20);
    let output = Fixture::new().run(
        config,
        r#"
        export default c=>{
          let calls=0, lateReadRejected=false;
          c.holo.engineGate(async r=>{
            if(++calls===1){
              await new Promise(resolve=>setTimeout(resolve,80));
              try{await r.sourceReader.read({maxBytes:1});}
              catch{lateReadRejected=true;}
              return {action:'allow'};
            }
            return lateReadRejected?{action:'allow'}:{action:'deny',reasonCode:'host.late_reader_live'};
          });
        };
        "#,
        r#"
        import assert from 'node:assert/strict';
        assert.throws(()=>eval('globalThis.lateSourceExecuted=true'));
        await new Promise(resolve=>setTimeout(resolve,200));
        assert.equal(globalThis.lateSourceExecuted,undefined);
        assert.equal(eval('42'),42);
        console.log('READER_TIMEOUT_OK');
        "#,
    );
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("READER_TIMEOUT_OK"));
}
