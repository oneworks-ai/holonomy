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
            "holo-source-reader-wasm-module-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn file(&self, name: &str, source: &str) {
        fs::write(self.0.join(name), source).unwrap();
    }

    fn run(&self, config: Value, plugin: &str, entry: &str) -> Output {
        self.file("host.json", &config.to_string());
        self.file("plugin.mjs", plugin);
        self.file("entry.mjs", entry);
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

fn config(
    mode: &str,
    selected: bool,
    max_read_bytes: usize,
    max_reads: usize,
    timeout: u64,
) -> Value {
    let mut value = json!({
        "schemaVersion": 1,
        "sandboxPolicy": {
            "schemaVersion": 2,
            "diagnostics": {
                "sourceReader": mode,
                "maxSourceReadBytes": if mode == "boundedSource" { 65536 } else { 0 },
                "observerEvents": [],
                "maxQueuedEvents": 0,
                "maxObserverCallbackMs": 1,
                "retentionMs": 0
            },
            "codeGeneration": {
                "strings": {"access": "none"},
                "wasm": {"access": "controlled", "maxSourceBytes": 131072,
                    "maxOperations": 16, "decisionTimeoutMs": timeout},
                "dynamicImport": {"access": "controlled", "maxSourceBytes": 131072,
                    "maxOperations": 16, "decisionTimeoutMs": timeout}
            }
        },
        "plugins": [{"id": "gate", "use": "./plugin.mjs"}]
    });
    if selected {
        value["diagnosticSourceReader"] = json!({
            "capabilityName": "host.diagnostics.source.read",
            "maxReadBytes": max_read_bytes,
            "maxReads": max_reads
        });
    }
    value
}

fn success(output: Output, marker: &str) {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stdout}\n{stderr}");
    assert!(stdout.contains(marker), "{stdout}\n{stderr}");
}

#[test]
fn wasm_reader_preserves_zero_bytes_full_digest_and_revokes_returned_copy() {
    success(
        Fixture::new().run(
            config("boundedSource", true, 8, 2, 1000),
            r#"
            export default c => {
              let calls = 0, first, stale;
              c.holo.engineGate(async r => {
                if (r.codeKind !== 'wasm' || r.sourceBytes !== 8 ||
                    r.sourceSha256 !== '93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476' ||
                    r.sourcePrefix !== undefined || !Object.isFrozen(r) || !r.sourceReader ||
                    JSON.stringify(r).includes('sourcePrefix'))
                  return {action:'deny',reasonCode:'host.wasm_metadata'};
                if (calls++ === 1 && (!first.every(b => b === 0) ||
                    await stale.read({maxBytes:1}).then(() => true, () => false)))
                  return {action:'deny',reasonCode:'host.wasm_stale'};
                const bytes = await r.sourceReader.read({maxBytes:8});
                if (bytes.length !== 8 || bytes.some((b,i) => b !== [0,97,115,109,1,0,0,0][i]))
                  return {action:'deny',reasonCode:'host.wasm_bytes'};
                try { await r.sourceReader.read({maxBytes:1});
                  return {action:'deny',reasonCode:'host.wasm_reuse'}; } catch {}
                first = bytes; stale = r.sourceReader;
                return {action:'allow'};
              });
            };
            "#,
            r#"
            import assert from 'node:assert/strict';
            const bytes = Uint8Array.from([0,97,115,109,1,0,0,0]);
            assert.ok(new WebAssembly.Module(bytes) instanceof WebAssembly.Module);
            assert.ok(await WebAssembly.compile(bytes) instanceof WebAssembly.Module);
            assert.equal(typeof globalThis.__holoControlHost, 'undefined');
            console.log('WASM_READER_BYTES_OK');
            "#,
        ),
        "WASM_READER_BYTES_OK",
    );
}

#[test]
fn module_reader_uses_trusted_unicode_source_and_keeps_synthetic_unavailable() {
    let fixture = Fixture::new();
    let source = format!(
        "/*{}😀*/globalThis.largeModuleRuns=(globalThis.largeModuleRuns??0)+1;export const answer=42;",
        "x".repeat(65_533)
    );
    fixture.file("lazy.mjs", &source);
    let snapshot = holonomy_desktop_host::SourceStore::new(&fixture.0.join("lazy.mjs"))
        .unwrap()
        .read("app://workspace/lazy.mjs")
        .unwrap()
        .unwrap();
    let snapshot: Value = serde_json::from_str(&snapshot).unwrap();
    let mut configuration = config("boundedSource", true, 65_536, 2, 1000);
    configuration["plugins"][0]["config"] = json!({
        "bytes": source.len(),
        "sha": snapshot["sha256"]
    });
    success(
        fixture.run(
            configuration,
            r#"
            export default (c, expected) => { c.holo.engineGate(async r => {
              if (r.codeKind !== 'module') return {action:'deny',reasonCode:'host.wrong_kind'};
              if (r.metadataSupport.source === 'unavailable') {
                return r.sourceReader === undefined && r.sourceSha256 === undefined
                  ? {action:'allow'} : {action:'deny',reasonCode:'host.synthetic_reader'};
              }
              if (!r.origin.endsWith('/lazy.mjs') || r.sourceBytes !== expected.bytes ||
                  r.sourceSha256 !== expected.sha || r.sourcePrefix !== undefined ||
                  !r.sourceReader) return {action:'deny',reasonCode:'host.module_metadata'};
              const bytes = await r.sourceReader.read({maxBytes:65536});
              return bytes.length === 65536 && bytes[0] === 47 && bytes[1] === 42 &&
                bytes[65534] === 120 && bytes[65535] === 240
                ? {action:'allow'} : {action:'deny',reasonCode:'host.module_prefix'};
            }); };
            "#,
            r#"
            import assert from 'node:assert/strict';
            assert.equal((await import('./lazy.mjs')).answer,42);
            assert.equal(globalThis.largeModuleRuns,1);
            assert.equal(typeof (await import('node:os')).arch,'function');
            console.log('MODULE_READER_UNICODE_OK');
            "#,
        ),
        "MODULE_READER_UNICODE_OK",
    );
}

#[test]
fn denied_wasm_and_module_never_execute_and_metadata_only_has_no_reader() {
    let fixture = Fixture::new();
    fixture.file(
        "lazy.mjs",
        "globalThis.deniedModuleRuns=1;export const answer=42;",
    );
    success(
        fixture.run(
            config("boundedSource", true, 64, 2, 1000),
            r#"export default c => { c.holo.engineGate(async r => {
              if (!r.sourceReader) return {action:'deny',reasonCode:'host.missing_reader'};
              await r.sourceReader.read({maxBytes:64});
              return {action:'deny',reasonCode:'host.source_denied'};
            }); };"#,
            r#"
            import assert from 'node:assert/strict';
            const bytes = Uint8Array.from([0,97,115,109,1,0,0,0]);
            assert.throws(() => new WebAssembly.Module(bytes));
            await assert.rejects(import('./lazy.mjs'));
            assert.equal(globalThis.deniedModuleRuns,undefined);
            console.log('READER_DENY_NO_EXECUTION_OK');
            "#,
        ),
        "READER_DENY_NO_EXECUTION_OK",
    );
    success(
        fixture.run(
            config("metadataOnly", false, 0, 0, 1000),
            "export default c => { c.holo.engineGate(r => r.sourceReader === undefined ? {action:'allow'} : {action:'deny',reasonCode:'host.reader_leak'}); };",
            r#"
            import assert from 'node:assert/strict';
            assert.ok(new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0])));
            assert.equal((await import('./lazy.mjs')).answer,42);
            console.log('READER_NO_SELECTION_OK');
            "#,
        ),
        "READER_NO_SELECTION_OK",
    );
}

#[test]
fn timed_out_wasm_gate_revokes_reader_and_rejects_late_allow() {
    success(
        Fixture::new().run(
            config("boundedSource", true, 8, 2, 20),
            r#"
            export default c => {
              let calls=0, revoked=false;
              c.holo.engineGate(async r => {
                if (++calls === 1) {
                  const bytes = await r.sourceReader.read({maxBytes:8});
                  await new Promise(resolve => setTimeout(resolve,80));
                  let lateRejected=false;
                  try { await r.sourceReader.read({maxBytes:1}); } catch { lateRejected=true; }
                  revoked=lateRejected && bytes.every(byte => byte === 0);
                  return {action:'allow'};
                }
                return revoked ? {action:'allow'} : {action:'deny',reasonCode:'host.late_reader_live'};
              });
            };
            "#,
            r#"
            import assert from 'node:assert/strict';
            const bytes=Uint8Array.from([0,97,115,109,1,0,0,0]);
            await assert.rejects(WebAssembly.compile(bytes));
            await new Promise(resolve => setTimeout(resolve,200));
            assert.ok(await WebAssembly.compile(bytes));
            console.log('WASM_READER_TIMEOUT_OK');
            "#,
        ),
        "WASM_READER_TIMEOUT_OK",
    );
}

#[test]
fn reader_budget_is_shared_by_wasm_and_dynamic_module() {
    let fixture = Fixture::new();
    fixture.file("lazy.mjs", "export const answer=42;");
    success(
        fixture.run(
            config("boundedSource", true, 8, 1, 1000),
            r#"
            export default c => { c.holo.engineGate(async r => {
              if (r.codeKind === 'wasm') {
                if (!r.sourceReader) return {action:'deny',reasonCode:'host.wasm_reader_missing'};
                const bytes=await r.sourceReader.read({maxBytes:8});
                return bytes.length===8 && bytes[0]===0
                  ? {action:'allow'} : {action:'deny',reasonCode:'host.wasm_bytes'};
              }
              return r.codeKind==='module' && r.sourceReader===undefined
                ? {action:'allow'} : {action:'deny',reasonCode:'host.read_budget'};
            }); };
            "#,
            r#"
            import assert from 'node:assert/strict';
            assert.ok(new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0])));
            assert.equal((await import('./lazy.mjs')).answer,42);
            console.log('CROSS_KIND_READER_BUDGET_OK');
            "#,
        ),
        "CROSS_KIND_READER_BUDGET_OK",
    );
}

#[test]
fn timed_out_module_gate_revokes_reader_and_rejects_late_allow() {
    let fixture = Fixture::new();
    fixture.file(
        "blocked.mjs",
        "globalThis.blockedRuns=1;export const answer=0;",
    );
    fixture.file("allowed.mjs", "export const answer=42;");
    success(
        fixture.run(
            config("boundedSource", true, 16, 2, 20),
            r#"
            export default c => {
              let revoked=false;
              c.holo.engineGate(async r => {
                if (r.origin.endsWith('/blocked.mjs')) {
                  const bytes=await r.sourceReader.read({maxBytes:16});
                  await new Promise(resolve => setTimeout(resolve,80));
                  let lateRejected=false;
                  try { await r.sourceReader.read({maxBytes:1}); } catch { lateRejected=true; }
                  revoked=lateRejected && bytes.every(byte => byte===0);
                  return {action:'allow'};
                }
                return revoked && r.origin.endsWith('/allowed.mjs')
                  ? {action:'allow'} : {action:'deny',reasonCode:'host.module_late_reader'};
              });
            };
            "#,
            r#"
            import assert from 'node:assert/strict';
            await assert.rejects(import('./blocked.mjs'));
            await new Promise(resolve => setTimeout(resolve,200));
            assert.equal(globalThis.blockedRuns,undefined);
            assert.equal((await import('./allowed.mjs')).answer,42);
            console.log('MODULE_READER_TIMEOUT_OK');
            "#,
        ),
        "MODULE_READER_TIMEOUT_OK",
    );
}
