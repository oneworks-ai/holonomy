use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-native-audit-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn run(&self, config: Value, entry: &str) -> Output {
        self.run_with_plugin(
            config,
            r#"export default ctx => {
            ctx.holo.engineGate(async request => {
                try { await request.sourceReader.read({maxBytes:32}); return {action:'allow'}; }
                catch { return {action:'deny',reasonCode:'host.audit_unavailable'}; }
            });
        };"#,
            entry,
        )
    }
    fn run_with_plugin(&self, mut config: Value, plugin: &str, entry: &str) -> Output {
        if config.get("diagnosticAudit").is_none() {
            config["diagnosticAudit"] = json!({"path":"./private-audit.jsonl","maxBytes":1024});
        }
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
    fn audit(&self) -> Vec<Value> {
        fs::read_to_string(self.0.join("private-audit.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn config() -> Value {
    json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2,
        "diagnostics":{"sourceReader":"boundedSource","maxSourceReadBytes":64,"observerEvents":[],"maxQueuedEvents":0,"maxObserverCallbackMs":1,"retentionMs":0},
        "codeGeneration":{"strings":{"access":"controlled","maxSourceBytes":1024,"maxOperations":16,"decisionTimeoutMs":1000},
            "wasm":{"access":"controlled","maxSourceBytes":1024,"maxOperations":16,"decisionTimeoutMs":1000},
            "dynamicImport":{"access":"controlled","maxSourceBytes":1024,"maxOperations":16,"decisionTimeoutMs":1000}}},
        "diagnosticSourceReader":{"capabilityName":"host.diagnostics.source.read","maxReadBytes":32,"maxReads":8},
        "plugins":[{"id":"gate","use":"./plugin.mjs"}]})
}
fn success(output: &Output) {
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
fn native_source_audit_is_durable_private_and_contains_no_source() {
    let fixture = Fixture::new();
    let output = fixture.run(config(), "import assert from 'node:assert/strict'; assert.equal(eval('40+2'),42); console.log('AUDIT_OK');");
    success(&output);
    let rows = fixture.audit();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["request"]["readBytes"], 4);
    assert_eq!(rows[0]["request"]["sourceBytes"], 4);
    assert_eq!(
        rows[0]["request"]["sourceSha256"],
        "5ea4202659491c599e6e629625e9ee9baad51ddeb6b8e38e7b500dce13a96d44"
    );
    assert!(!rows[0].to_string().contains("40+2"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("private-audit"));
    assert_eq!(
        fs::metadata(fixture.0.join("private-audit.jsonl"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}
#[test]
fn full_audit_rejects_read_before_bytes_are_disclosed_and_code_executes() {
    let fixture = Fixture::new();
    let audit = fixture.0.join("private-audit.jsonl");
    success(&fixture.run(config(), "eval('40+2');"));
    let mut full = fixture.audit()[0].to_string();
    full.push_str(&" ".repeat(1023 - full.len()));
    full.push('\n');
    fs::write(&audit, &full).unwrap();
    fs::set_permissions(&audit, fs::Permissions::from_mode(0o600)).unwrap();
    let output = fixture.run(config(), "import assert from 'node:assert/strict'; assert.throws(()=>eval('globalThis.auditBypass=true')); assert.equal(globalThis.auditBypass,undefined); console.log('AUDIT_DENIED');");
    success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("AUDIT_DENIED"));
    assert_eq!(fs::read_to_string(&audit).unwrap(), full);
}
#[test]
fn unsafe_audit_installation_fails_before_guest_entry() {
    let fixture = Fixture::new();
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o755)).unwrap();
    let output = fixture.run(config(), "console.log('GUEST_MUST_NOT_RUN');");
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("GUEST_MUST_NOT_RUN"));
}
#[test]
fn source_kinds_share_the_bounded_audit_sequence() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("dep.mjs"), "export const value=42;").unwrap();
    let mut input = config();
    input["diagnosticSourceReader"]["maxReads"] = json!(4);
    let output = fixture.run(input,
        "import assert from 'node:assert/strict'; assert.equal(eval('40+2'),42); await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0])); assert.equal((await import('./dep.mjs')).value,42); assert.throws(()=>eval('globalThis.overAuditLimit=true')); assert.equal(globalThis.overAuditLimit,undefined); console.log('AUDIT_BOUND_OK');");
    success(&output);
    let rows = fixture.audit();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["request"]["codeKind"], "strings");
    assert_eq!(rows[1]["request"]["codeKind"], "wasm");
    assert_eq!(rows[1]["sequence"], 2);
    assert_eq!(rows[2]["request"]["codeKind"], "module");
    assert_eq!(rows[2]["sequence"], 3);
    assert_eq!(rows[0]["sessionId"], rows[1]["sessionId"]);
}

#[test]
fn host_math_replacement_cannot_change_audited_copy_length_or_options() {
    let fixture = Fixture::new();
    let source = "globalThis.minProof=42";
    let output = fixture.run_with_plugin(config(), r#"export default c => {
        c.holo.engineGate(async r => {
            const original = Math.min;
            Math.min = () => 1;
            let bytes;
            try { bytes = await r.sourceReader.read({maxBytes:32}); }
            finally { Math.min = original; }
            return bytes.length === r.sourceBytes ? {action:'allow'} : {action:'deny',reasonCode:'host.wrong_bytes'};
        });
    };"#, "import assert from 'node:assert/strict'; eval('globalThis.minProof=42'); assert.equal(globalThis.minProof,42);");
    success(&output);
    assert_eq!(fixture.audit()[0]["request"]["readBytes"], source.len());
}

#[test]
fn empty_host_dependency_cannot_also_be_the_audit_sink() {
    let fixture = Fixture::new();
    let dependency = fixture.0.join("dep.mjs");
    fs::write(&dependency, "").unwrap();
    fs::set_permissions(&dependency, fs::Permissions::from_mode(0o600)).unwrap();
    let plugin = "import './dep.mjs'; export default c=>{c.holo.engineGate(async r=>{await r.sourceReader.read({maxBytes:1});return {action:'allow'};});};";
    success(&fixture.run_with_plugin(config(), plugin, "eval('42');"));
    let mut input = config();
    input["diagnosticAudit"] = json!({"path":"./dep.mjs","maxBytes":1024});
    let output = fixture.run_with_plugin(
        input,
        plugin,
        "console.log('GUEST_MUST_NOT_RUN');eval('42');",
    );
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("GUEST_MUST_NOT_RUN"));
    assert_eq!(fs::read(&dependency).unwrap(), b"");
}
