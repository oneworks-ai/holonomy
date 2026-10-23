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
            "holo-engine-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn run(&self, plugin: &str, entry: &str, strings: Value) -> Output {
        fs::write(self.0.join("plugin.mjs"), plugin).unwrap();
        fs::write(self.0.join("entry.mjs"), entry).unwrap();
        fs::write(self.0.join("host.json"),json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2,"codeGeneration":{"strings":strings,"wasm":{"access":"none"},"dynamicImport":{"access":"none"}}},"plugins":[{"id":"gate","use":"./plugin.mjs"}]}).to_string()).unwrap();
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
fn controlled(ms: u64, bytes: u64, operations: u64) -> Value {
    json!({"access":"controlled","maxSourceBytes":bytes,"maxOperations":operations,"decisionTimeoutMs":ms})
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

#[test]
fn asynchronous_cordis_gate_preserves_real_eval_and_function_semantics() {
    success(Fixture::new().run(r#"
      export default context=>{context.holo.engineGate(async request=>{
        if(request.operation!=='runtime.code.generate.strings'||request.metadataSupport.entryDetail!=='unavailable'||request.origin!==undefined||!Object.isFrozen(request.runtime))throw Error('bad metadata');
        await new Promise(resolve=>setTimeout(resolve,5));return {action:'allow'};
      });};
    "#,r#"
      import assert from 'node:assert/strict';
      let local=40;eval('local+=2');assert.equal(local,42);
      assert.equal((0,eval)('typeof local'),'undefined');
      assert.equal(Function('return 7')(),7);
      const Async=Object.getPrototypeOf(async function(){}).constructor;
      assert.equal(await Async('return 8')(),8);
      const Generator=Object.getPrototypeOf(function*(){}).constructor;
      assert.equal(Generator('yield 9')().next().value,9);
      const AsyncGenerator=Object.getPrototypeOf(async function*(){}).constructor;
      assert.equal((await AsyncGenerator('yield 10')().next()).value,10);
      assert.equal(Function('return globalThis')(),globalThis);
      assert.equal(Function('return typeof process.binding')(),'undefined');
      assert.equal(Function('return typeof __holoControlHost')(),'undefined');
      assert.throws(()=>new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])));
      console.log('NATIVE_ENGINE_ALLOW_OK');
    "#,controlled(1000,65536,32)),"NATIVE_ENGINE_ALLOW_OK");
}

#[test]
fn hard_policy_limits_cannot_be_overridden_by_an_allowing_plugin() {
    let plugin = "export default context=>{context.holo.engineGate(()=>({action:'allow'}));};";
    success(Fixture::new().run(plugin,"import assert from 'node:assert/strict';assert.throws(()=>eval('1'));console.log('POLICY_DENY_OK');",json!({"access":"none"})),"POLICY_DENY_OK");
    success(Fixture::new().run(plugin,"import assert from 'node:assert/strict';assert.equal(eval('1'),1);assert.throws(()=>eval('22'));console.log('SOURCE_LIMIT_OK');",controlled(1000,1,10)),"SOURCE_LIMIT_OK");
    success(Fixture::new().run(plugin,"import assert from 'node:assert/strict';assert.equal(eval('1'),1);assert.equal(eval('1'),1);assert.throws(()=>eval('1'));console.log('OP_LIMIT_OK');",controlled(1000,100,2)),"OP_LIMIT_OK");
}

#[test]
fn timeout_aborts_cooperative_gate_and_late_allow_cannot_compile() {
    success(Fixture::new().run(r#"
      export default context=>{
        let calls=0,aborted=false;
        context.holo.engineGate(request=>{
          if(++calls>1)return {action:aborted?'allow':'deny',...(aborted?{}:{reasonCode:'host.abort_missing'})};
          request.signal.addEventListener('abort',()=>{aborted=true},{once:true});
          return new Promise(resolve=>setTimeout(()=>resolve({action:'allow'}),150));
        });
      };
    "#,r#"
      import assert from 'node:assert/strict';
      assert.throws(()=>eval('globalThis.lateCompiled=true'));
      await new Promise(resolve=>setTimeout(resolve,250));
      assert.equal(globalThis.lateCompiled,undefined);
      assert.equal(eval('42'),42);
      console.log('COOPERATIVE_GATE_TIMEOUT_OK');
    "#,controlled(30,4096,16)),"COOPERATIVE_GATE_TIMEOUT_OK");
}

#[test]
fn never_settling_gate_is_cancelled_without_blocking_later_decisions() {
    success(Fixture::new().run("export default c=>{let count=0;c.holo.engineGate(()=>++count===1?new Promise(()=>{}):{action:'allow'});};",
        "import assert from 'node:assert/strict';assert.throws(()=>eval('1'));await new Promise(r=>setTimeout(r,100));assert.equal(eval('42'),42);console.log('NEVER_SETTLE_DENIED_OK');",
        controlled(30,4096,16)),"NEVER_SETTLE_DENIED_OK");
}

#[test]
fn stuck_gate_handler_is_terminated_after_cancel_ack_grace() {
    let started = std::time::Instant::now();
    let output=Fixture::new().run("export default c=>{c.holo.engineGate(()=>{while(true){}});};",
        "import assert from 'node:assert/strict';assert.throws(()=>eval('1'));console.log('GATE_WAIT_RETURNED');while(true){}",
        controlled(20,4096,16));
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("GATE_WAIT_RETURNED"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Host worker"));
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
}

#[test]
fn deny_invalid_decision_duplicate_next_and_ambiguous_source_fail_closed() {
    for plugin in [
        "export default c=>{c.holo.engineGate(()=>({action:'deny',reasonCode:'host.user_denied'}));};",
        "export default c=>{c.holo.engineGate(()=>({action:'allow',source:'replacement'}));};",
        "export default c=>{c.holo.engineGate(async(r,next)=>{await next();try{await next()}catch{}return {action:'allow'}});c.holo.engineGate(()=>({action:'allow'}));};",
    ] {
        success(Fixture::new().run(plugin,"import assert from 'node:assert/strict';assert.throws(()=>eval('globalThis.bad=true'));assert.equal(globalThis.bad,undefined);console.log('GATE_DENIED_OK');",controlled(1000,4096,16)),"GATE_DENIED_OK");
    }
    success(
        Fixture::new().run(
            "export default c=>{c.holo.engineGate(()=>({action:'allow'}));};",
            r#"
      import assert from 'node:assert/strict';
      assert.throws(()=>eval('"'+String.fromCharCode(0xd800)+'"'));
      assert.throws(()=>eval('"'+String.fromCharCode(0xd801)+'"'));
      assert.equal(eval('"\\ud800"').charCodeAt(0),0xd800);
      console.log('EXACT_SOURCE_OK');
    "#,
            controlled(1000, 4096, 16),
        ),
        "EXACT_SOURCE_OK",
    );
}
