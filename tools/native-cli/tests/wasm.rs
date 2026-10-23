use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    process::{Command, Output},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct WasmServer {
    origin: String,
    hits: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl WasmServer {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let worker_hits = hits.clone();
        let worker_stop = stop.clone();
        let thread = thread::spawn(move || {
            while !worker_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut request = Vec::new();
                        let mut chunk = [0_u8; 1024];
                        while request.len() < 4096 {
                            match stream.read(&mut chunk) {
                                Ok(0) | Err(_) => break,
                                Ok(count) => request.extend_from_slice(&chunk[..count]),
                            }
                            if request.windows(4).any(|part| part == b"\r\n\r\n") {
                                break;
                            }
                        }
                        worker_hits.fetch_add(1, Ordering::Relaxed);
                        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/wasm\r\nContent-Length: 8\r\nConnection: close\r\n\r\n\0asm\x01\0\0\0");
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            origin,
            hits,
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for WasmServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-wasm-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn run(&self, plugin: &str, entry: &str, wasm: Value) -> Output {
        self.run_config(plugin, entry, wasm, None, 5000)
    }

    fn run_network(&self, plugin: &str, entry: &str, wasm: Value) -> Output {
        self.run_config(
            plugin,
            entry,
            wasm,
            Some((mock_network_policy(), mock_wasm_rules())),
            5000,
        )
    }

    fn run_restricted(&self, plugin: &str, entry: &str, wasm: Value, origin: &str) -> Output {
        let mut policy = mock_network_policy();
        policy["access"] = json!("restricted");
        policy["allowedOrigins"] = json!([origin]);
        policy["allowedSchemes"] = json!(["http"]);
        policy["allowPrivateNetwork"] = json!(true);
        self.run_config(
            plugin,
            entry,
            wasm,
            Some((policy, json!({"mode":"passthrough","rules":[]}))),
            5000,
        )
    }

    fn run_config(
        &self,
        plugin: &str,
        entry: &str,
        wasm: Value,
        network: Option<(Value, Value)>,
        timeout_ms: u64,
    ) -> Output {
        fs::write(self.0.join("plugin.mjs"), plugin).unwrap();
        fs::write(self.0.join("entry.mjs"), entry).unwrap();
        let mut config = json!({
          "schemaVersion": 1,
          "sandboxPolicy": {
            "schemaVersion": 2,
            "codeGeneration": {
              "strings": {"access":"none"},
              "wasm": wasm,
              "dynamicImport": {"access":"none"}
            }
          },
          "plugins": [{"id":"gate","use":"./plugin.mjs"}]
        });
        if let Some((policy, network_rules)) = network {
            config["sandboxPolicy"]["network"] = policy;
            config["networkRules"] = network_rules;
        }
        fs::write(self.0.join("host.json"), config.to_string()).unwrap();
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--timeout",
                &timeout_ms.to_string(),
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

fn mock_network_policy() -> Value {
    json!({
      "access":"mockOnly",
      "allowedOrigins":["https://api.example"],
      "allowedSchemes":["https"],
      "allowPrivateNetwork":false,
      "limits":{
        "maxChunkBytes":1024,
        "maxConcurrentConnections":4,
        "maxHeaderBytes":4096,
        "maxHeaders":32,
        "maxRedirects":5,
        "maxRequestBodyBytes":4096,
        "maxResponseBodyBytes":4096,
        "maxUrlBytes":4096,
        "socketTimeoutMs":2000
      },
      "requestBodyInspection":{"access":"none"}
    })
}

fn mock_wasm_rules() -> Value {
    json!({
      "mode":"failClosed",
      "rules":[{
        "id":"wasm",
        "priority":1,
        "match":{"path":{"op":"exact","value":"/wasm"}},
        "action":{
          "type":"respond",
          "status":200,
          "headers":[["content-type","application/wasm"]],
          "body":{"kind":"base64","value":"AGFzbQEAAAA="}
        }
      },{
        "id":"slow-wasm",
        "priority":1,
        "match":{"path":{"op":"exact","value":"/slow-wasm"}},
        "action":{
          "type":"respond",
          "status":200,
          "headers":[["content-type","application/wasm"]],
          "body":{"kind":"base64","value":"AGFzbQEAAAA="},
          "delayMs":300
        }
      },{
        "id":"failed-wasm",
        "priority":1,
        "match":{"path":{"op":"exact","value":"/failed-wasm"}},
        "action":{"type":"fail","code":"unavailable"}
      }]
    })
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn controlled(ms: u64, bytes: u64, operations: u64) -> Value {
    json!({
      "access":"controlled",
      "maxSourceBytes":bytes,
      "maxOperations":operations,
      "decisionTimeoutMs":ms
    })
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

const ALLOW: &str = r#"
  export default context=>{context.holo.engineGate(async request=>{
    if(request.operation!=='runtime.code.generate.wasm'||request.metadataSupport.source!=='available'||
       request.sourceBytes!==8||!/^[0-9a-f]{64}$/.test(request.sourceSha256))throw Error('bad wasm metadata');
    await new Promise(resolve=>setTimeout(resolve,2)); return {action:'allow'};
  });};
"#;

#[test]
fn native_hook_allows_real_module_compile_and_byte_instantiate_once_each() {
    success(
        Fixture::new().run(
            ALLOW,
            r#"
      import assert from 'node:assert/strict';
      const bytes=new Uint8Array([0,97,115,109,1,0,0,0]);
      const direct=new WebAssembly.Module(bytes);
      const compiled=await WebAssembly.compile(bytes);
      const result=await WebAssembly.instantiate(bytes);
      const fromModule=await WebAssembly.instantiate(compiled);
      assert.ok(direct instanceof WebAssembly.Module);
      assert.ok(compiled instanceof WebAssembly.Module);
      assert.ok(result.module instanceof WebAssembly.Module);
      assert.ok(fromModule instanceof WebAssembly.Instance);
      assert.equal(WebAssembly.Module.prototype.constructor,WebAssembly.Module);
      assert.equal(Object.getPrototypeOf(direct).constructor,WebAssembly.Module);
      // Validation produces no Module and V8 does not invoke its codegen hook.
      assert.equal(WebAssembly.validate(bytes),true);
      assert.throws(()=>new WebAssembly.Module(bytes));
      console.log('NATIVE_WASM_THREE_ENTRYPOINTS_OK');
    "#,
            controlled(1000, 1024, 3),
        ),
        "NATIVE_WASM_THREE_ENTRYPOINTS_OK",
    );
}

#[test]
fn streaming_compiles_and_instantiates_genuine_responses_through_one_gate_each() {
    let source = r#"
      import assert from 'node:assert/strict';
      const bytes=new Uint8Array([0,97,115,109,1,0,0,0]);
      const response=new Response(bytes,{headers:{'content-type':'application/wasm'}});
      const sequence=[];
      const source=Promise.resolve().then(()=>{sequence.push('source');return response});
      const pending=WebAssembly.compileStreaming(source);
      assert.ok(pending instanceof Promise);
      sequence.push('caller');
      const compiled=await pending;
      assert.deepEqual(sequence,['caller','source']);
      assert.ok(compiled instanceof WebAssembly.Module);
      assert.equal(response.bodyUsed,true);
      assert.throws(()=>new WebAssembly.Module(bytes));
      console.log('WASM_STREAMING_COMPILE_ONCE_OK');
    "#;
    success(
        Fixture::new().run_network(ALLOW, source, controlled(1000, 8, 1)),
        "WASM_STREAMING_COMPILE_ONCE_OK",
    );
    success(
        Fixture::new().run_network(
            ALLOW,
            r#"
      import assert from 'node:assert/strict';
      const response=await fetch('https://api.example/wasm');
      assert.equal(response.headers.get('content-type'),'application/wasm');
      const result=await WebAssembly.instantiateStreaming(response);
      assert.ok(result.module instanceof WebAssembly.Module);
      assert.ok(result.instance instanceof WebAssembly.Instance);
      assert.throws(()=>new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])));
      console.log('WASM_STREAMING_FETCH_ONCE_OK');
    "#,
            controlled(1000, 8, 1),
        ),
        "WASM_STREAMING_FETCH_ONCE_OK",
    );
    success(
        Fixture::new().run_network(
            ALLOW,
            r#"
      import assert from 'node:assert/strict';
      const b=new Uint8Array([0,97,115,109,1,0,0,0]);
      const response=new Response(b,{headers:{'content-type':'application/wasm'}});
      let traps=0;
      response.bodyController.clone=()=>{traps++;throw Error('clone trap')};
      Response.fromNetwork=()=>{traps++;throw Error('factory trap')};
      const clone=response.clone();
      const module=await WebAssembly.compileStreaming(clone);
      assert.ok(module instanceof WebAssembly.Module);
      assert.equal(traps,0);
      console.log('WASM_STREAMING_CLONE_OK');
    "#,
            controlled(1000, 8, 1),
        ),
        "WASM_STREAMING_CLONE_OK",
    );
}

#[test]
fn streaming_fetch_uses_selected_restricted_native_network_authority() {
    let server = WasmServer::new();
    let source = format!(
        r#"
      import assert from 'node:assert/strict';
      const compiled=await WebAssembly.compileStreaming(fetch('{origin}/wasm'));
      assert.ok(compiled instanceof WebAssembly.Module);
      await assert.rejects(fetch('http://127.0.0.1:1/wasm'),{{code:'network.invalid_url'}});
      assert.throws(()=>new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0])));
      console.log('WASM_STREAMING_RESTRICTED_FETCH_OK');
    "#,
        origin = server.origin
    );
    success(
        Fixture::new().run_restricted(ALLOW, &source, controlled(1000, 8, 1), &server.origin),
        "WASM_STREAMING_RESTRICTED_FETCH_OK",
    );
    assert_eq!(server.hits.load(Ordering::Acquire), 1);
}

#[test]
fn streaming_obeys_selected_wasm_policy_and_source_limit() {
    let source = r#"
      import assert from 'node:assert/strict';
      const response=new Response(new Uint8Array([0,97,115,109,1,0,0,0]),
        {headers:{'content-type':'application/wasm'}});
      const pending=WebAssembly.compileStreaming(response);
      assert.ok(pending instanceof Promise);
      await assert.rejects(pending);
      console.log('WASM_STREAMING_POLICY_DENIED_OK');
    "#;
    success(
        Fixture::new().run_network(
            "export default c=>{c.holo.engineGate(()=>{throw Error('policy bypass')});};",
            source,
            json!({"access":"none"}),
        ),
        "WASM_STREAMING_POLICY_DENIED_OK",
    );
    success(
        Fixture::new().run_network(ALLOW, source, controlled(1000, 7, 1)),
        "WASM_STREAMING_POLICY_DENIED_OK",
    );
}

#[test]
fn streaming_rejects_fake_responses_mime_status_and_body_errors_before_gate() {
    let deny_if_reached =
        "export default c=>{c.holo.engineGate(()=>{throw Error('unexpected gate admission')});};";
    success(
        Fixture::new().run_network(
            deny_if_reached,
            r#"
      import assert from 'node:assert/strict';
      const b=new Uint8Array([0,97,115,109,1,0,0,0]);
      let traps=0;
      const invalid={get arrayBuffer(){traps++;throw Error('guest getter')}};
      const proxy=new Proxy(new Response(b,{headers:{'content-type':'application/wasm'}}),{
        get(target,key){if(key==='then')return undefined;traps++;throw Error('proxy trap')}
      });
      const forged=Response.fromNetwork({
        body:{bytes(){traps++;throw Error('forged body')}},
        headers:[['content-type','application/wasm']],
        maxBodyBytes:8,redirected:false,status:200,statusText:'',url:''
      });
      for(const source of [invalid,proxy,forged,null,new Uint8Array(b)]) {
        const pending=WebAssembly.compileStreaming(Promise.resolve(source));
        assert.ok(pending instanceof Promise);
        await assert.rejects(pending,/must resolve to a Response/);
      }
      assert.equal(traps,0);
      for(const response of [
        new Response(b),
        new Response(b,{headers:{'content-type':'text/plain'}}),
        new Response(b,{status:404,headers:{'content-type':'application/wasm'}})
      ]) await assert.rejects(WebAssembly.instantiateStreaming(response),/application\/wasm/);
      const consumed=new Response(b,{headers:{'content-type':'application/wasm'}});
      await consumed.bytes();
      await assert.rejects(WebAssembly.compileStreaming(consumed));
      const closed=new Response(b,{headers:{'content-type':'application/wasm'}});
      closed.dispose();
      await assert.rejects(WebAssembly.compileStreaming(closed));
      const networkClosed=await fetch('https://api.example/wasm');
      networkClosed.dispose();
      await assert.rejects(WebAssembly.instantiateStreaming(networkClosed));
      const controller=new AbortController();
      const cancelled=WebAssembly.compileStreaming(fetch('https://api.example/slow-wasm',
        {signal:controller.signal}));
      controller.abort();
      await assert.rejects(cancelled,{code:'network.cancelled'});
      await assert.rejects(WebAssembly.compileStreaming(fetch('https://api.example/failed-wasm')),
        {code:'network.offline'});
      await assert.rejects(WebAssembly.compileStreaming(Promise.reject(Error('source failed'))),/source failed/);
      console.log('WASM_STREAMING_INVALID_OK');
    "#,
            controlled(1000, 8, 1),
        ),
        "WASM_STREAMING_INVALID_OK",
    );
}

#[test]
fn streaming_hard_body_limit_rejects_before_wasm_gate() {
    success(
        Fixture::new().run_network(
            "export default c=>{c.holo.engineGate(()=>{throw Error('oversize reached gate')});};",
            r#"
      import assert from 'node:assert/strict';
      const response=new Response(new Uint8Array(16*1024*1024+1),
        {headers:{'content-type':'application/wasm'}});
      await assert.rejects(WebAssembly.compileStreaming(response),{code:'network.response_too_large'});
      console.log('WASM_STREAMING_HARD_LIMIT_OK');
    "#,
            controlled(1000, 16 * 1024 * 1024, 1),
        ),
        "WASM_STREAMING_HARD_LIMIT_OK",
    );
}

#[test]
fn streaming_ignores_guest_response_getters_and_observes_launch_deadline() {
    success(
        Fixture::new().run_network(
            ALLOW,
            r#"
      import assert from 'node:assert/strict';
      const response=new Response(new Uint8Array([0,97,115,109,1,0,0,0]),
        {headers:{'content-type':'application/wasm'}});
      let traps=0;
      const trap=()=>{traps++;throw Error('guest getter')};
      const controller=response.bodyController;
      const headers=response.headers;
      headers.get=trap;
      Object.defineProperty(headers,'entriesMap',{get:trap});
      controller.next=trap;
      controller.bytes=trap;
      controller.source={pull:trap};
      for(const key of ['arrayBuffer','status','headers','bodyController']) {
        Object.defineProperty(response,key,{get:trap});
      }
      Object.defineProperty(Uint8Array.prototype,'byteLength',{configurable:true,get:trap});
      let module;
      try { module=await WebAssembly.compileStreaming(response); }
      finally { delete Uint8Array.prototype.byteLength; }
      assert.ok(module instanceof WebAssembly.Module);
      assert.equal(traps,0);
      console.log('WASM_STREAMING_GETTERS_OK');
    "#,
            controlled(1000, 8, 1),
        ),
        "WASM_STREAMING_GETTERS_OK",
    );
    let timed = Fixture::new().run_config(
        ALLOW,
        "await WebAssembly.compileStreaming(new Promise(()=>{}));console.log('UNREACHABLE');",
        controlled(1000, 8, 1),
        Some((mock_network_policy(), mock_wasm_rules())),
        150,
    );
    assert!(!timed.status.success());
    assert!(!String::from_utf8_lossy(&timed.stdout).contains("UNREACHABLE"));
}

#[test]
fn unsafe_sources_are_rejected_without_guest_callbacks_or_gate_admission() {
    success(
        Fixture::new().run(
            "export default c=>{c.holo.engineGate(()=>{throw Error('unsafe source reached gate')});};",
            r#"
      import assert from 'node:assert/strict';
      let traps=0; const trap=()=>{traps++;throw Error('trap')};
      const bytes=new Uint8Array([0,97,115,109,1,0,0,0]);
      const proxy=new Proxy(bytes,{get:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap});
      const detachedBuffer=new ArrayBuffer(8),detached=new Uint8Array(detachedBuffer);detachedBuffer.transfer();
      for(const source of [{},proxy,new Uint8Array(new SharedArrayBuffer(8)),
        new Uint8Array(new ArrayBuffer(8,{maxByteLength:16})),detached]) {
        assert.throws(()=>new WebAssembly.Module(source));
        for(const invoke of [()=>WebAssembly.compile(source),()=>WebAssembly.instantiate(source)]) {
          // An exception here fails entry: async Wasm APIs must return first.
          const pending=invoke();
          assert.ok(pending instanceof Promise);
          await assert.rejects(pending);
        }
      }
      assert.equal(traps,0);
      console.log('NATIVE_WASM_UNSAFE_SOURCE_OK');
    "#,
            controlled(1000, 1024, 8),
        ),
        "NATIVE_WASM_UNSAFE_SOURCE_OK",
    );
}

#[test]
fn source_and_operation_limits_fail_closed() {
    let plugin = "export default c=>{c.holo.engineGate(()=>({action:'allow'}));};";
    success(
        Fixture::new().run(
            plugin,
            "import assert from 'node:assert/strict';const b=new Uint8Array([0,97,115,109,1,0,0,0]);assert.throws(()=>new WebAssembly.Module(b));console.log('WASM_SOURCE_LIMIT_OK');",
            controlled(1000, 7, 4),
        ),
        "WASM_SOURCE_LIMIT_OK",
    );
    success(
        Fixture::new().run(
            plugin,
            "import assert from 'node:assert/strict';const b=new Uint8Array([0,97,115,109,1,0,0,0]);new WebAssembly.Module(b);assert.throws(()=>new WebAssembly.Module(b));console.log('WASM_OPERATION_LIMIT_OK');",
            controlled(1000, 8, 1),
        ),
        "WASM_OPERATION_LIMIT_OK",
    );
}

#[test]
fn denied_policy_rejects_async_wasm_calls_without_synchronous_throw() {
    success(
        Fixture::new().run(
            "export default c=>{c.holo.engineGate(()=>{throw Error('policy bypass')});};",
            r#"
      import assert from 'node:assert/strict';
      const b=new Uint8Array([0,97,115,109,1,0,0,0]);
      for(const invoke of [()=>WebAssembly.compile(b),()=>WebAssembly.instantiate(b)]) {
        const pending=invoke();
        assert.ok(pending instanceof Promise);
        await assert.rejects(pending);
      }
      console.log('WASM_ASYNC_POLICY_DENIED_OK');
    "#,
            json!({"access":"none"}),
        ),
        "WASM_ASYNC_POLICY_DENIED_OK",
    );
}

#[test]
fn asynchronous_compilation_stays_alive_through_import_binding_and_reentry() {
    success(
        Fixture::new().run(
            "export default c=>{c.holo.engineGate(()=>({action:'allow'}));};",
            r#"
      import assert from 'node:assert/strict';
      const bytes=new Uint8Array([0,97,115,109,1,0,0,0,
        1,5,1,96,0,1,127,2,7,1,1,109,1,102,0,0,
        3,2,1,0,7,7,1,3,114,117,110,0,1,10,6,1,4,0,16,0,11]);
      const empty=new Uint8Array([0,97,115,109,1,0,0,0]);
      assert.equal(WebAssembly.validate(bytes),true);
      const plain=await WebAssembly.instantiate(bytes,{m:{f:()=>42}});
      assert.equal(plain.instance.exports.run(),42);
      let gets=0;
      const nested=await WebAssembly.instantiate(bytes,{get m(){
        gets++;new WebAssembly.Module(empty);
        return {get f(){gets++;return ()=>7}};
      }});
      assert.equal(nested.instance.exports.run(),7);assert.equal(gets,2);
      const outcomes=await Promise.allSettled(Array.from({length:33},()=>WebAssembly.compile(empty)));
      assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,32);
      assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
      assert.ok(await WebAssembly.compile(empty) instanceof WebAssembly.Module);
      await assert.rejects(WebAssembly.instantiate(bytes,{m:{get f(){throw Error('IMPORT_REJECT')}}}),/IMPORT_REJECT/);
      // Deliberately do not await: an admitted native compile owns liveness.
      WebAssembly.instantiate(bytes,{m:{f:()=>99}}).then(result=>{
        assert.equal(result.instance.exports.run(),99);console.log('WASM_IMPORT_LIVENESS_OK');
      });
    "#,
            controlled(1000, 1024, 128),
        ),
        "WASM_IMPORT_LIVENESS_OK",
    );
}

#[test]
fn deadline_cancels_late_token_and_fresh_stage_can_succeed() {
    success(
        Fixture::new().run(
            r#"
      export default context=>{let calls=0,aborted=false;context.holo.engineGate(request=>{
        if(++calls>1)return {action:aborted?'allow':'deny',...(aborted?{}:{reasonCode:'host.abort_missing'})};
        request.signal.addEventListener('abort',()=>{aborted=true},{once:true});
        return new Promise(resolve=>setTimeout(()=>resolve({action:'allow'}),150));
      });};
    "#,
            r#"
      import assert from 'node:assert/strict';
      const b=new Uint8Array([0,97,115,109,1,0,0,0]);
      assert.throws(()=>new WebAssembly.Module(b));
      await new Promise(resolve=>setTimeout(resolve,250));
      assert.ok(new WebAssembly.Module(b) instanceof WebAssembly.Module);
      console.log('WASM_DEADLINE_CANCEL_OK');
    "#,
            controlled(30, 1024, 4),
        ),
        "WASM_DEADLINE_CANCEL_OK",
    );
}
