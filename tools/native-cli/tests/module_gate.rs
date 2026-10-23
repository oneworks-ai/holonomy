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
        let path = std::env::temp_dir().join(format!(
            "holo-loader-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str, source: &str) {
        let path = self.0.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, source).unwrap();
    }
    fn run(&self, plugin: &str, entry: &str, policy: Option<Value>, config: Value) -> Output {
        self.file("entry.mjs", entry);
        self.file("plugin.mjs", plugin);
        let mut command = Command::new(env!("CARGO_BIN_EXE_holo"));
        command.args(["--timeout", "5000"]);
        if let Some(policy) = policy {
            self.file("host.json", &json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2,
                "codeGeneration":{"strings":{"access":"none"},"wasm":{"access":"none"},"dynamicImport":policy}},
                "plugins":[{"id":"gate","use":"./plugin.mjs","config":config}]}).to_string());
            command.args(["--host-config", "host.json"]);
        }
        command
            .arg("entry.mjs")
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
fn controlled(ms: u64, bytes: u64, operations: u64) -> Option<Value> {
    Some(
        json!({"access":"controlled","maxSourceBytes":bytes,"maxOperations":operations,"decisionTimeoutMs":ms}),
    )
}
fn success(output: Output, marker: &str) {
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains(marker));
}
const ALLOW: &str = "export default c=>{c.holo.engineGate(()=>({action:'allow'}))};";

#[test]
fn controlled_import_gates_exact_source_and_cache_hits_before_execution() {
    let f = Fixture::new();
    let source = "globalThis.moduleRuns=(globalThis.moduleRuns??0)+1;export const value='é';";
    f.file("lazy.mjs", source);
    let snapshot = holonomy_desktop_host::SourceStore::new(&f.0.join("lazy.mjs"))
        .unwrap()
        .read("app://workspace/lazy.mjs")
        .unwrap()
        .unwrap();
    let snapshot: Value = serde_json::from_str(&snapshot).unwrap();
    success(f.run(r#"
      export default (c, config)=>{let calls=0;c.holo.engineGate(async r=>{
        if(r.operation!=='runtime.module.import'||r.codeKind!=='module'||r.entryDetail.kind!=='dynamicImport'||r.entryDetail.source!=='loader'||
           r.metadataSupport.origin!=='exact'||r.metadataSupport.callsite!=='unavailable'||r.origin!=='app://workspace/lazy.mjs'||
           r.sourceSha256!==config.sha||r.sourceBytes!==config.bytes)throw Error('metadata mismatch');
        await new Promise(resolve=>setTimeout(resolve,10));
        return ++calls===1?{action:'allow'}:{action:'deny',reasonCode:'host.cached_denied'};
      });};
    "#, r#"
      import assert from 'node:assert/strict';
      assert.equal((await import('./lazy.mjs')).value,'é');
      assert.equal(globalThis.moduleRuns,1);
      await assert.rejects(import('./lazy.mjs'));
      assert.equal(globalThis.moduleRuns,1);console.log('MODULE_CACHE_GATE_OK');
    "#, controlled(1000,4096,8), json!({"sha":snapshot["sha256"],"bytes":source.len()})), "MODULE_CACHE_GATE_OK");
}

#[test]
fn private_planner_is_not_affected_by_guest_prototypes_and_does_not_leak_errors() {
    let f = Fixture::new();
    f.file("lazy.mjs", "export const value=42;");
    success(f.run("", r#"
      import assert from 'node:assert/strict';
      let traps=0;
      Object.prototype.toJSON=Array.prototype.toJSON=function(){traps++;throw Error('GUEST_JSON_POISON')};
      try { assert.equal((await import('./lazy.mjs')).value,42); }
      finally {delete Object.prototype.toJSON;delete Array.prototype.toJSON;}
      assert.equal(traps,0);
      const missing='./missing.mjs';
      try {await import(missing);assert.fail('missing accepted')} catch(error) {
        assert.equal(Object.getPrototypeOf(error),Error.prototype);
      }
      assert.equal(typeof globalThis.__holoModulePlannerHost,'undefined');
      console.log('PRIVATE_PLANNER_OK');
    "#,None,json!({})),"PRIVATE_PLANNER_OK");
}

#[test]
fn controlled_detached_import_keeps_runtime_alive_without_blocking_guest_timers() {
    let f = Fixture::new();
    f.file("lazy.mjs", "export const answer=42;");
    success(f.run("export default c=>{c.holo.engineGate(async()=>{await new Promise(r=>setTimeout(r,80));return {action:'allow'}})};",
        "import('./lazy.mjs').then(m=>console.log('DETACHED_IMPORT_OK:'+m.answer));",controlled(1000,4096,4),json!({})),"DETACHED_IMPORT_OK:42");
    success(f.run("export default c=>{c.holo.engineGate(async()=>{await new Promise(r=>setTimeout(r,80));return {action:'allow'}})};",r#"
      import assert from 'node:assert/strict';let ticks=0;const timer=setInterval(()=>ticks++,5);
      const m=await import('./lazy.mjs');clearInterval(timer);
      assert.equal(m.answer,42);assert.ok(ticks>1);console.log('IMPORT_TIMER_PROGRESS_OK');
    "#,controlled(1000,4096,4),json!({})),"IMPORT_TIMER_PROGRESS_OK");
}

#[test]
fn module_gate_policy_size_operation_and_timeout_are_fail_closed() {
    let f = Fixture::new();
    f.file(
        "lazy.mjs",
        "globalThis.executed=true;export const answer=42;",
    );
    for policy in [Some(json!({"access":"none"})), controlled(1000, 1, 4)] {
        success(f.run(ALLOW,"import assert from 'node:assert/strict';await assert.rejects(import('./lazy.mjs'));assert.equal(globalThis.executed,undefined);console.log('POLICY_DENIED_OK');",policy,json!({})),"POLICY_DENIED_OK");
    }
    success(f.run(ALLOW,"import assert from 'node:assert/strict';await import('./lazy.mjs');await assert.rejects(import('./lazy.mjs'));console.log('IMPORT_LIMIT_OK');",controlled(1000,4096,1),json!({})),"IMPORT_LIMIT_OK");
    success(f.run("export default c=>{c.holo.engineGate(async()=>{await new Promise(r=>setTimeout(r,150));return {action:'allow'}})};",r#"
      import assert from 'node:assert/strict';await assert.rejects(import('./lazy.mjs'));
      await new Promise(r=>setTimeout(r,220));assert.equal(globalThis.executed,undefined);
      console.log('IMPORT_LATE_ALLOW_DENIED_OK');
    "#,controlled(30,4096,4),json!({})),"IMPORT_LATE_ALLOW_DENIED_OK");
}

#[test]
fn static_dependencies_nested_dynamic_import_and_cjs_provenance_are_distinct() {
    let f = Fixture::new();
    f.file("parent.mjs","import {value} from './static.mjs';export {value};export const nested=()=>import('./nested.mjs');");
    f.file("static.mjs", "export const value=41;");
    f.file("nested.mjs", "export const value=42;");
    f.file(
        "a/start.cjs",
        "module.exports=()=>import('./child.mjs');\n//# sourceURL=app://workspace/b/start.cjs",
    );
    f.file("a/child.mjs", "export const value='A';");
    f.file("b/child.mjs", "export const value='B';");
    success(f.run(r#"export default c=>{c.holo.engineGate(r=>{
      if(r.origin==='app://workspace/static.mjs')throw Error('static closure gated');
      if(r.origin==='app://workspace/nested.mjs')return {action:'deny',reasonCode:'host.nested_denied'};
      return {action:'allow'};
    })};"#,r#"
      import assert from 'node:assert/strict';
      const parent=await import('./parent.mjs');assert.equal(parent.value,41);await assert.rejects(parent.nested());
      const start=await import('./a/start.cjs');assert.equal((await start.default()).value,'A');
      assert.equal(typeof (await import('node:os')).arch,'function');
      console.log('MODULE_PROVENANCE_OK');
    "#,controlled(1000,4096,8),json!({})),"MODULE_PROVENANCE_OK");
}

#[test]
fn nested_imports_keep_outer_lease_counted_while_draining() {
    let f = Fixture::new();
    f.file("leaf.mjs", "export const value=1;");
    f.file("parent.mjs", "const results=await Promise.allSettled(Array.from({length:128},()=>import('./leaf.mjs')));export const rejected=results.filter(r=>r.status==='rejected').length;");
    success(
        f.run(
            "",
            r#"
      import assert from 'node:assert/strict';const parent=await import('./parent.mjs');
      assert.equal(parent.rejected,1);assert.equal((await import('./leaf.mjs')).value,1);
      console.log('NESTED_IMPORT_QUOTA_OK');
    "#,
            None,
            json!({}),
        ),
        "NESTED_IMPORT_QUOTA_OK",
    );
}
