use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Watching {
    root: PathBuf,
    child: Child,
    output: Receiver<String>,
    readers: Vec<JoinHandle<()>>,
    config: Value,
}

impl Watching {
    fn start(plugin: &str, entry: &str) -> Self {
        Self::start_with_gate(plugin, entry, false)
    }
    fn start_with_gate(plugin: &str, entry: &str, gate: bool) -> Self {
        Self::start_with_gate_timeout(plugin, entry, gate, 2000)
    }
    fn start_with_gate_timeout(plugin: &str, entry: &str, gate: bool, timeout_ms: u32) -> Self {
        let policy = gate.then(|| json!({"strings":{"access":"controlled","maxSourceBytes":4096,"maxOperations":512,"decisionTimeoutMs":timeout_ms},"wasm":{"access":"none"},"dynamicImport":{"access":"none"}}));
        Self::start_with_code_generation(plugin, entry, policy)
    }
    fn start_with_code_generation(plugin: &str, entry: &str, policy: Option<Value>) -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-live-plugins-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("plugins")).unwrap();
        fs::create_dir(root.join("data")).unwrap();
        fs::write(root.join("data/input"), "payload").unwrap();
        fs::write(root.join("plugins/index.mjs"), plugin).unwrap();
        fs::write(root.join("plugins/flag.mjs"), "export const deny=false;").unwrap();
        fs::write(root.join("entry.mjs"), entry).unwrap();
        let mut config = json!({
            "schemaVersion":1,
            "sandboxPolicy":{"schemaVersion":2,"systemInformation":{"defaultMode":"unavailable","fields":{"os.arch":{"allowedModes":["synthetic"],"maxPrecision":"exact"}}}},
            "systemProjection":{"schemaVersion":1,"fields":{"os.arch":{"mode":"synthetic","precision":"exact","value":"arm64"}}},
            "plugins":[{"id":"policy","use":"./plugins/index.mjs","config":{"revision":1}}]
        });
        config["sandboxPolicy"]["filesystem"] = json!({
            "access":"sandboxed", "roots":[{"rootId":"workspace","virtualUrl":"holo-fs://workspace/","rights":["read"],"symlinks":"deny"}],
            "limits":{"maxReadBytes":4096,"maxWriteBytes":4096,"maxOpenHandles":8,"maxWatchers":0,"maxDirectoryEntries":32,"maxQueuedEvents":0}
        });
        config["filesystemRoots"] = json!([{"rootId":"workspace","hostPath":"./data"}]);
        if let Some(policy) = policy {
            config["sandboxPolicy"]["codeGeneration"] = policy;
        }
        fs::write(root.join("host.json"), config.to_string()).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--watch",
                "--timeout",
                "15000",
                "--host-config",
                "host.json",
                "entry.mjs",
            ])
            .current_dir(&root)
            .env_clear()
            .env("PATH", "")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let (send, output) = mpsc::channel();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let first = send.clone();
        let readers = vec![
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if first.send(line).is_err() {
                        break;
                    }
                }
            }),
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if send.send(line).is_err() {
                        break;
                    }
                }
            }),
        ];
        Self {
            root,
            child,
            output,
            readers,
            config,
        }
    }
    fn wait(&self, wanted: &str) {
        self.wait_all(&[wanted]);
    }
    fn wait_all(&self, wanted: &[&str]) {
        let deadline = Instant::now() + Duration::from_secs(6);
        let mut observed = Vec::new();
        let mut remaining = wanted.to_vec();
        while Instant::now() < deadline {
            match self.output.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => {
                    remaining.retain(|wanted| !line.contains(wanted));
                    if remaining.is_empty() {
                        return;
                    }
                    observed.push(line);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }
        }
        panic!("Missing {remaining:?}; received {observed:?}");
    }
    fn write_config(&self, config: &str) {
        fs::write(self.root.join("next.json"), config).unwrap();
        fs::rename(self.root.join("next.json"), self.root.join("host.json")).unwrap();
    }
    fn revision(&mut self, revision: u32) {
        self.config["plugins"][0]["config"]["revision"] = json!(revision);
        self.write_config(&self.config.to_string());
    }
}
impl Drop for Watching {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

const PLUGIN: &str = "import {deny} from './flag.mjs'; export default ctx => { ctx.holo.intercept({operation:'system.os.arch.read'}, (invocation,next) => deny ? ctx.holo.deny(invocation) : next(), {execution:'sync'}); };";
const ENTRY: &str = "import os from 'node:os'; setInterval(()=>{try{console.log('VALUE:'+os.arch())}catch(e){console.log('DENIED:'+e.code)}},20);";

#[test]
fn rejected_candidate_sources_remain_private_to_live_guest_imports() {
    let policy = json!({"strings":{"access":"none"},"wasm":{"access":"none"},"dynamicImport":{"access":"controlled","maxSourceBytes":65536,"maxOperations":16,"decisionTimeoutMs":1000}});
    let entry = r#"
      import fs from 'node:fs';
      let probing=false;
      setInterval(async()=>{
        if(probing || fs.readFileSync('holo-fs://workspace/input','utf8') !== 'probe') return;
        probing=true;
        const publicPath='./guest-public.mjs';
        if((await import(publicPath)).value===42) console.log('PUBLIC_IMPORT_OK');
        const candidatePath='./plugins/candidate.mjs';
        try { await import(candidatePath); console.log('PRIVATE_IMPORT_LEAK'); }
        catch { console.log('PRIVATE_IMPORT_REJECTED'); }
      },20);
    "#;
    let mut runtime = Watching::start_with_code_generation(
        "export default c => { c.holo.engineGate(()=>({action:'allow'})); };",
        entry,
        Some(policy),
    );
    runtime.wait("plugin watch ready");
    fs::write(
        runtime.root.join("guest-public.mjs"),
        "export const value=42;",
    )
    .unwrap();
    fs::write(
        runtime.root.join("plugins/candidate.mjs"),
        "import '../entry.mjs'; console.log('CANDIDATE_MUST_NOT_RUN'); export default () => {}; ",
    )
    .unwrap();
    runtime.config["plugins"][0]["use"] = json!("./plugins/candidate.mjs");
    runtime.revision(2);
    runtime.wait("plugin update rejected");
    fs::write(runtime.root.join("data/input"), "probe").unwrap();
    let deadline = Instant::now() + Duration::from_secs(6);
    let mut public = false;
    let mut private = false;
    while Instant::now() < deadline {
        if let Ok(line) = runtime.output.recv_timeout(Duration::from_millis(100)) {
            assert!(
                !line.contains("CANDIDATE_MUST_NOT_RUN") && !line.contains("PRIVATE_IMPORT_LEAK")
            );
            public |= line.contains("PUBLIC_IMPORT_OK");
            private |= line.contains("PRIVATE_IMPORT_REJECTED");
            if public && private {
                break;
            }
        }
    }
    assert!(
        public && private,
        "old allow Gate and source exclusion must both remain active"
    );
}

#[test]
fn native_watch_rejects_guest_source_conflicts_before_candidate_execution() {
    let mut runtime = Watching::start(PLUGIN, ENTRY);
    runtime.wait("plugin watch ready");
    runtime.wait("VALUE:arm64");
    // A new Host entry cannot claim the already planned Guest entry, even via
    // a hard link. The prior Cordis graph must continue serving invocations.
    fs::hard_link(
        runtime.root.join("entry.mjs"),
        runtime.root.join("plugins/alias.mjs"),
    )
    .unwrap();
    fs::write(
        runtime.root.join("plugins/candidate.mjs"),
        "import './alias.mjs'; console.log('CANDIDATE_MUST_NOT_RUN'); export default () => {}; ",
    )
    .unwrap();
    runtime.config["plugins"][0]["use"] = json!("./plugins/candidate.mjs");
    runtime.revision(2);
    let deadline = Instant::now() + Duration::from_secs(6);
    let mut rejected = false;
    let mut old_graph = false;
    while Instant::now() < deadline {
        if let Ok(line) = runtime.output.recv_timeout(Duration::from_millis(100)) {
            assert!(!line.contains("CANDIDATE_MUST_NOT_RUN"));
            if line.contains("plugin update rejected") {
                rejected = true;
            }
            if rejected && line.contains("VALUE:arm64") {
                old_graph = true;
                break;
            }
        }
    }
    assert!(
        rejected && old_graph,
        "candidate rejection and old graph were not observed"
    );
    // An entry-level collision follows the same fail-closed path.
    runtime.config["plugins"][0]["use"] = json!("./plugins/alias.mjs");
    runtime.revision(3);
    runtime.wait("plugin update rejected");
    runtime.wait("VALUE:arm64");
}

#[test]
fn native_watch_updates_dependencies_and_preserves_last_good_graph() {
    let mut runtime = Watching::start(PLUGIN, ENTRY);
    runtime.wait("plugin watch ready");
    runtime.wait("VALUE:arm64");
    fs::write(
        runtime.root.join("plugins/flag.mjs"),
        "export const deny=true;",
    )
    .unwrap();
    runtime.revision(2);
    runtime.wait("plugin graph revision 2 active");
    runtime.wait("DENIED:ERR_ACCESS_DENIED");

    runtime.write_config("{\"plugins\":[");
    runtime.wait("plugin update rejected");
    runtime.wait("DENIED:ERR_ACCESS_DENIED");
    let mut changed_policy = runtime.config.clone();
    changed_policy["sandboxPolicy"]["filesystem"]["roots"][0]["rights"] = json!(["read", "write"]);
    runtime.write_config(&changed_policy.to_string());
    runtime.wait("non-plugin configuration changed");
    runtime.wait("DENIED:ERR_ACCESS_DENIED");

    fs::write(runtime.root.join("plugins/index.mjs"), "export default ctx => {ctx.holo.intercept({operation:'system.os.arch.read'},(i,next)=>next(),{execution:'sync'}); throw new Error('broken candidate');};").unwrap();
    runtime.revision(3);
    runtime.wait("plugin update rejected");
    runtime.wait("DENIED:ERR_ACCESS_DENIED");
    fs::write(runtime.root.join("plugins/index.mjs"), PLUGIN).unwrap();
    fs::write(
        runtime.root.join("plugins/flag.mjs"),
        "export const deny=false;",
    )
    .unwrap();
    runtime.revision(4);
    runtime.wait("plugin graph revision 3 active");
    runtime.wait("VALUE:arm64");
    runtime.config["plugins"] = json!([]);
    runtime.write_config(&runtime.config.to_string());
    runtime.wait("plugin graph revision 4 active");
    runtime.wait("VALUE:arm64");
}

#[test]
fn native_watch_preserves_last_good_graph_for_invalid_schema_then_recovers() {
    let mut runtime = Watching::start(PLUGIN, ENTRY);
    runtime.wait("plugin watch ready");
    runtime.wait("VALUE:arm64");
    let package = runtime.root.join("plugins/schema-plugin");
    fs::create_dir(&package).unwrap();
    fs::write(package.join("index.mjs"), PLUGIN).unwrap();
    fs::write(package.join("flag.mjs"), "export const deny=false;").unwrap();
    fs::write(
        package.join("package.json"),
        r#"{"holo":{"kind":"runtime-plugin","apiVersion":1,"entry":"./index.mjs","configSchema":"./schema.json"}}"#,
    )
    .unwrap();
    fs::write(
        package.join("schema.json"),
        r#"{"type":"object","additionalProperties":false,"properties":{"revision":{"type":"integer"}},"required":["revision"]}"#,
    )
    .unwrap();
    runtime.config["plugins"] =
        json!([{"id":"schema","use":"./plugins/schema-plugin","config":{"revision":2}}]);
    runtime.write_config(&runtime.config.to_string());
    runtime.wait("plugin graph revision 2 active");
    runtime.wait("VALUE:arm64");

    runtime.config["plugins"][0]["config"]["revision"] = json!("not-an-integer");
    runtime.write_config(&runtime.config.to_string());
    runtime.wait("plugin update rejected");
    runtime.wait("VALUE:arm64");

    fs::write(package.join("schema.json"), "{").unwrap();
    runtime.config["plugins"][0]["config"]["revision"] = json!(3);
    runtime.write_config(&runtime.config.to_string());
    runtime.wait("plugin update rejected");
    runtime.wait("VALUE:arm64");

    fs::write(
        package.join("schema.json"),
        r#"{"type":"object","additionalProperties":false,"properties":{"revision":{"type":"integer"}},"required":["revision"]}"#,
    )
    .unwrap();
    runtime.revision(4);
    runtime.wait("plugin graph revision 3 active");
    runtime.wait("VALUE:arm64");

    fs::write(package.join("schema.json"), "false").unwrap();
    runtime.revision(5);
    runtime.wait("plugin update rejected");
    runtime.wait("VALUE:arm64");
    fs::write(package.join("schema.json"), "true").unwrap();
    runtime.revision(6);
    runtime.wait("plugin graph revision 4 active");
    runtime.wait("VALUE:arm64");
}

#[test]
fn schema_helper_timeout_does_not_block_live_gates_and_watch_can_recover() {
    const GATE: &str = "export default c=>{c.holo.engineGate(async()=>{await new Promise(r=>setTimeout(r,2));return {action:'allow'}})};";
    let mut runtime = Watching::start_with_gate_timeout(
        GATE,
        "setInterval(()=>console.log('GATE_OK:'+eval('1+1')),20);",
        true,
        100,
    );
    runtime.wait("plugin watch ready");
    runtime.wait("GATE_OK:2");
    let package = runtime.root.join("plugins/bounded-schema");
    fs::create_dir(&package).unwrap();
    fs::write(package.join("package.json"),
        r#"{"holo":{"kind":"runtime-plugin","apiVersion":1,"entry":"./index.mjs","configSchema":"./schema.json"}}"#).unwrap();
    fs::write(package.join("index.mjs"), GATE).unwrap();
    fs::write(
        package.join("schema.json"),
        r#"{"type":"string","pattern":"^(a+)+$"}"#,
    )
    .unwrap();
    runtime.config["plugins"] = json!([{"id":"bounded","use":"./plugins/bounded-schema","config":format!("{}!", "a".repeat(32768))}]);
    runtime.write_config(&runtime.config.to_string());
    // The helper spends up to 750 ms in the regex. Existing async Gates have
    // 100 ms deadlines and must keep progressing in the same Host worker.
    runtime.wait("plugin update rejected");
    runtime.wait("GATE_OK:2");
    assert!(runtime.child.try_wait().unwrap().is_none());
    fs::write(package.join("schema.json"), "true").unwrap();
    runtime.config["plugins"][0]["config"] = json!("recovered");
    runtime.write_config(&runtime.config.to_string());
    runtime.wait("plugin graph revision 2 active");
    runtime.wait("GATE_OK:2");
}

#[test]
fn native_watch_requires_explicit_host_config_and_is_not_a_guest_flag() {
    let output = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args(["--watch", "entry.js"])
        .env_clear()
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("requires --host-config"));
    let root = std::env::temp_dir().join(format!(
        "holo-guest-watch-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    fs::write(root.join("entry.js"), "console.log(process.argv[2]);").unwrap();
    let guest_argument = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args(["entry.js", "--watch"])
        .current_dir(&root)
        .env_clear()
        .output()
        .unwrap();
    assert!(guest_argument.status.success());
    assert_eq!(String::from_utf8_lossy(&guest_argument.stdout), "--watch\n");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn watch_keeps_an_idle_entry_alive_for_later_config_updates() {
    let mut runtime = Watching::start(PLUGIN, "console.log('IDLE_ENTRY_DONE');");
    runtime.wait("IDLE_ENTRY_DONE");
    assert!(runtime.child.try_wait().unwrap().is_none());
    runtime.config["plugins"] = json!([]);
    runtime.write_config(&runtime.config.to_string());
    runtime.wait("plugin graph revision 2 active");
    assert!(runtime.child.try_wait().unwrap().is_none());
}

#[test]
fn old_inflight_plugin_import_remains_in_its_graph_after_new_graph_publication() {
    let plugin = r#"
      export default (ctx, config) => {
        let entered=false;
        ctx.holo.intercept({operation:'system.os.arch.read'}, (request,next) => entered ? next() : ctx.holo.deny(request), {execution:'sync'});
        ctx.holo.intercept({operation:'filesystem.file.read'}, async (request,next) => {
          entered=true;
          if(config.revision===1) await new Promise(resolve=>setTimeout(resolve,1200));
          const {deny}=await import('./flag.mjs');
          if(deny) return ctx.holo.deny(request);
          return next();
        }, {execution:'async',timeoutMs:5000});
      }
    "#;
    let entry = r#"
      import os from 'node:os'; import fs from 'node:fs/promises';
      let ready=false, done=false, sawNew=false;
      fs.readFile('holo-fs://workspace/input','utf8').then(value=>{done=true;console.log('OLD_CALL:'+value)}, error=>console.log('OLD_ERROR:'+error.code));
      setInterval(()=>{
        if(!ready) { try{os.arch();ready=true;console.log('OLD_IN_MIDDLEWARE')}catch{} }
        if(ready&&!sawNew){try{os.arch()}catch{sawNew=true;fs.readFile('holo-fs://workspace/input','utf8').then(()=>console.log('NEW_UNEXPECTED_ALLOW'),error=>console.log('NEW_DENIED:'+error.code+':oldDone='+done))}}
      },20);
    "#;
    let mut runtime = Watching::start(plugin, entry);
    runtime.wait("OLD_IN_MIDDLEWARE");
    fs::write(
        runtime.root.join("plugins/flag.mjs"),
        "export const deny=true;",
    )
    .unwrap();
    runtime.revision(2);
    // Host stderr publication and Guest stdout delivery now have independent
    // threads/pipes. The Guest flag still proves the required call ordering.
    runtime.wait_all(&[
        "NEW_DENIED:EACCES:oldDone=false",
        "OLD_CALL:payload",
        "plugin graph revision 2 active",
    ]);
}

#[test]
fn gate_and_capability_scopes_publish_together_and_drain_the_old_gate_graph() {
    let plugin = r#"
      export default(ctx,config)=>{
        ctx.holo.intercept({operation:'system.os.arch.read'},(request,next)=>config.revision===1?next():ctx.holo.deny(request),{execution:'sync'});
        ctx.holo.engineGate(async()=>{
          if(config.revision===1)await new Promise(resolve=>setTimeout(resolve,800));
          const {deny}=await import('./flag.mjs');
          return deny?{action:'deny',reasonCode:'host.new_graph'}:{action:'allow'};
        });
      };
    "#;
    let entry = r#"
      import assert from 'node:assert/strict';import os from 'node:os';
      assert.equal(os.arch(),'arm64');console.log('GATE_START');
      assert.equal(eval('40+2'),42);console.log('OLD_GATE_ALLOWED');
      assert.throws(()=>os.arch(),{code:'ERR_ACCESS_DENIED'});
      assert.throws(()=>eval('40+2'));console.log('NEW_GRAPH_DENIED');
    "#;
    let mut runtime = Watching::start_with_gate(plugin, entry, true);
    runtime.wait("GATE_START");
    fs::write(
        runtime.root.join("plugins/flag.mjs"),
        "export const deny=true;",
    )
    .unwrap();
    runtime.revision(2);
    runtime.wait_all(&[
        "OLD_GATE_ALLOWED",
        "NEW_GRAPH_DENIED",
        "plugin graph revision 2 active",
    ]);
}

#[test]
fn immediate_gate_deny_retains_unawaited_downstream_until_dynamic_import_finishes() {
    let plugin = r#"
      export default(ctx,config)=>{
        ctx.holo.intercept({operation:'system.os.arch.read'},(request,next)=>{
          if(config.revision===2 && !globalThis.oldLeafDone)return ctx.holo.deny(request);
          return next();
        },{execution:'sync'});
        ctx.holo.engineGate((request,next)=>{
          if(config.revision===1)void next();
          return {action:'deny',reasonCode:'host.outer'};
        });
        ctx.holo.engineGate(async()=>{
          await new Promise(resolve=>setTimeout(resolve,800));
          const {deny}=await import('./flag.mjs');
          if(deny)throw Error('wrong graph');
          globalThis.oldLeafDone=true;
          return {action:'allow'};
        });
      };
    "#;
    let entry = r#"
      import assert from 'node:assert/strict';import os from 'node:os';
      assert.throws(()=>eval('globalThis.mustNotRun=true'));
      assert.equal(globalThis.mustNotRun,undefined);console.log('GATE_DENIED_EARLY');
      let denied=false;const timer=setInterval(()=>{
        try{os.arch();if(denied){console.log('OLD_DOWNSTREAM_SETTLED');clearInterval(timer)}}
        catch{denied=true;console.log('NEW_SCOPE_WAITING')}
      },20);
    "#;
    let mut runtime = Watching::start_with_gate(plugin, entry, true);
    runtime.wait("GATE_DENIED_EARLY");
    fs::write(
        runtime.root.join("plugins/flag.mjs"),
        "export const deny=true;",
    )
    .unwrap();
    runtime.revision(2);
    runtime.wait_all(&[
        "NEW_SCOPE_WAITING",
        "OLD_DOWNSTREAM_SETTLED",
        "plugin graph revision 2 active",
    ]);
}
