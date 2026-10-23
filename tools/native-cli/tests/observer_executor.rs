//! Real same-binary rusty_v8 helper tests; no Node or Runtime bootstrap.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::Shutdown,
    os::{fd::OwnedFd, unix::net::UnixStream},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const EVENT: &str = r#"{"schemaVersion":1,"event":"memory.pressure","generation":1,"observedAt":1,"sequence":1,"payload":{"level":"critical"}}"#;

fn module(name: &str, source: &str, dependencies: Vec<Value>) -> Value {
    json!({
        "url": format!("holo-plugins:///observer/{name}"),
        "format": "module",
        "source": source,
        "sha256": format!("{:x}", Sha256::digest(source.as_bytes())),
        "dependencies": dependencies,
    })
}

fn plan(source: &str, dependencies: Vec<Value>, extra: Vec<Value>) -> String {
    let mut modules = vec![module("main.mjs", source, dependencies)];
    modules.extend(extra);
    json!({
        "rootUrl": "holo-plugins:///observer/",
        "entryUrl": "holo-plugins:///observer/main.mjs",
        "modules": modules,
    })
    .to_string()
}

fn send(socket: &mut UnixStream, kind: u8, value: &Value) {
    let payload = serde_json::to_vec(value).unwrap();
    socket.write_all(&[kind]).unwrap();
    socket
        .write_all(&(payload.len() as u32).to_be_bytes())
        .unwrap();
    socket.write_all(&payload).unwrap();
}

fn response(socket: &mut UnixStream) -> [u8; 32] {
    let mut bytes = [0; 32];
    socket.read_exact(&mut bytes).unwrap();
    bytes
}

struct Helper {
    child: Child,
    socket: UnixStream,
    nonce: [u8; 16],
    sequence: u64,
}
impl Helper {
    fn new(source: &str, dependencies: Vec<Value>, extra: Vec<Value>) -> Self {
        let (socket, peer) = UnixStream::pair().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_holo"))
            .arg("__observer_executor_v1")
            .env_clear()
            .current_dir("/")
            .stdin(Stdio::from(OwnedFd::from(peer.try_clone().unwrap())))
            .stdout(Stdio::from(OwnedFd::from(peer)))
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let nonce = [7; 16];
        let mut helper = Self {
            child,
            socket,
            nonce,
            sequence: 0,
        };
        send(
            &mut helper.socket,
            1,
            &json!({
                "profile_id": "monitor", "plan": plan(source, dependencies, extra),
                "bundle_sha256": "0".repeat(64), "export_name": "default",
                "config": {"nested": [1]}, "epoch": 1, "nonce": nonce,
            }),
        );
        let ready = response(&mut helper.socket);
        assert_eq!(ready[0], 0x81);
        assert_eq!(&ready[1..5], &1_u32.to_be_bytes());
        assert_eq!(&ready[13..29], &nonce);
        helper
    }

    fn begin_call(&mut self) {
        self.sequence += 1;
        send(
            &mut self.socket,
            2,
            &json!({
                "epoch": 1, "sequence": self.sequence, "nonce": self.nonce, "event": EVENT,
            }),
        );
        let started = response(&mut self.socket);
        assert_eq!(started[0], 0x82);
        assert_eq!(&started[5..13], &self.sequence.to_be_bytes());
        assert_eq!(&started[13..29], &self.nonce);
    }

    fn complete(&mut self) -> (bool, bool) {
        let done = response(&mut self.socket);
        assert_eq!(done[0], 0x83);
        assert_eq!(&done[5..13], &self.sequence.to_be_bytes());
        assert_eq!(&done[13..29], &self.nonce);
        (done[29] != 0, done[30] != 0)
    }

    fn close(mut self) {
        let _ = self.socket.shutdown(Shutdown::Both);
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            if self.child.try_wait().unwrap().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        panic!("observer helper survived owner EOF");
    }
}
impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.socket.shutdown(Shutdown::Both);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn verified_static_edge_and_retained_sink_token() {
    let dependency = json!({
        "kind": "import", "specifier": "./dep.mjs",
        "resolvedUrl": "holo-plugins:///observer/dep.mjs",
    });
    let mut helper = Helper::new(
        "import { x } from './dep.mjs'; let old; export default (e,c,s) => { if (x !== 7 || !Object.isFrozen(e.payload) || !Object.isFrozen(c.nested)) throw Error(); if (old) old.publish(); else { old=s; s.publish(); } }",
        vec![dependency],
        vec![module("dep.mjs", "export const x = 7;", vec![])],
    );
    helper.begin_call();
    assert_eq!(helper.complete(), (false, true));
    helper.begin_call();
    assert_eq!(helper.complete(), (false, false));
    helper.close();
}

#[test]
fn poisoned_intrinsics_cannot_skip_nested_freeze_or_change_publish_event() {
    let mut helper = Helper::new(
        r#"const originalIsFrozen = Object.isFrozen;
            let calls = 0;
            Array.prototype[Symbol.iterator] = function* () {};
            Array.prototype.push = function () { throw Error('poisoned push'); };
            Object.freeze = function () { throw Error('poisoned freeze'); };
            Object.keys = function () { throw Error('poisoned keys'); };
            export default (event, config, sink) => {
              if (!originalIsFrozen(event) || !originalIsFrozen(event.payload) ||
                  !originalIsFrozen(config) || !originalIsFrozen(config.nested)) throw Error('mutable input');
              if (event.event !== 'memory.pressure' || event.payload.level !== 'critical' ||
                  config.nested[0] !== 1) throw Error('changed input');
              if (++calls === 1) sink.publish({event: 'forged', source: 'secret'});
              else sink.publish();
            }"#,
        vec![],
        vec![],
    );
    helper.begin_call();
    assert_eq!(helper.complete(), (false, false));
    helper.begin_call();
    assert_eq!(helper.complete(), (false, true));
    helper.close();
}

#[test]
fn async_rejection_and_codegen_denial_have_fixed_outcomes() {
    for source in [
        "export default async () => { throw Error('private'); }",
        "export default () => eval('1')",
        "export default async () => { await import('./missing.mjs'); }",
    ] {
        let mut helper = Helper::new(source, vec![], vec![]);
        helper.begin_call();
        assert_eq!(helper.complete(), (true, false));
        helper.close();
    }
}

#[test]
fn post_settlement_microtask_cannot_publish_or_leak_to_next_call() {
    let mut helper = Helper::new(
        "export default (_e,_c,s) => { Promise.resolve().then(() => s.publish()); }",
        vec![],
        vec![],
    );
    helper.begin_call();
    assert_eq!(helper.complete(), (false, false));
    helper.begin_call();
    assert_eq!(helper.complete(), (false, false));
    helper.close();
}

#[test]
fn synchronous_loop_and_pending_promise_do_not_starve_another_profile_or_owner_eof() {
    for source in [
        "export default () => { while (true) {} }",
        "export default async () => new Promise(() => {})",
    ] {
        let mut stuck = Helper::new(source, vec![], vec![]);
        stuck.begin_call();
        let mut other = Helper::new("export default (_e,_c,s) => s.publish()", vec![], vec![]);
        let started = Instant::now();
        other.begin_call();
        assert_eq!(other.complete(), (false, true));
        assert!(started.elapsed() < Duration::from_millis(500));
        stuck
            .socket
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let mut byte = [0];
        assert!(stuck.socket.read(&mut byte).is_err());
        stuck.close();
        other.close();
    }
}

#[test]
fn fatal_v8_heap_exhaustion_is_confined_to_its_helper_process() {
    let mut exhausted = Helper::new(
        "export default () => { const allocations=[]; while (true) allocations.push(new Array(1000000).fill(1)); }",
        vec![],
        vec![],
    );
    exhausted.begin_call();
    let mut other = Helper::new("export default (_e,_c,s) => s.publish()", vec![], vec![]);
    other.begin_call();
    assert_eq!(other.complete(), (false, true));
    let mut bytes = [0; 32];
    assert!(exhausted.socket.read_exact(&mut bytes).is_err());
    exhausted.close();
    other.close();
}
