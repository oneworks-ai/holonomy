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
            "holo-immediate-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn run(&self, entry: &str, source: &str) -> Output {
        fs::write(self.0.join(entry), source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args(["--timeout", "5000", entry])
            .env_clear()
            .env("PATH", "")
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

fn success(output: Output, expected: &str) {
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), expected);
}

#[test]
fn commonjs_immediate_inherits_shared_handle_and_callback_boundaries() {
    success(
        Fixture::new().run(
            "index.cjs",
            r#"
const assert=require('node:assert/strict');
const {setImmediate:schedule,clearImmediate:cancel}=require('node:timers');
assert.strictEqual(schedule,globalThis.setImmediate);
assert.strictEqual(cancel,globalThis.clearImmediate);
const order=['sync']; const identity={value:7};
process.nextTick(()=>order.push('initial:tick'));
Promise.resolve().then(()=>order.push('initial:promise'));
const first=schedule(function(value){
  assert.strictEqual(this,first);assert.strictEqual(value,identity);assert.equal(this.hasRef(),false);
  order.push('first');
  process.nextTick(()=>order.push('callback:tick'));
  Promise.resolve().then(()=>order.push('callback:promise'));
  schedule(()=>{order.push('nested');console.log(order.join('|'))});
},identity);
schedule(()=>order.push('second'));
const removed=schedule(()=>assert.fail('cancelled callback ran'));
cancel(removed);cancel(removed);cancel(null);cancel(undefined);
"#,
        ),
        "sync|initial:tick|initial:promise|first|callback:tick|callback:promise|second|nested\n",
    );
}

#[test]
fn esm_entry_retains_promise_priority_before_immediate_phase() {
    success(
        Fixture::new().run(
            "index.mjs",
            r#"
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers';
const order=['sync'];
process.nextTick(()=>order.push('tick'));
Promise.resolve().then(()=>order.push('promise'));
setImmediate(()=>{order.push('immediate');assert.deepEqual(order,['sync','promise','tick','immediate']);console.log('ESM_IMMEDIATE_OK')});
"#,
        ),
        "ESM_IMMEDIATE_OK\n",
    );
}

#[test]
fn unreferenced_immediate_does_not_keep_standalone_runtime_alive() {
    success(
        Fixture::new().run(
            "index.js",
            "setImmediate(()=>console.log('MUST_NOT_RUN')).unref();console.log('UNREF_MAIN_DONE');",
        ),
        "UNREF_MAIN_DONE\n",
    );
}
