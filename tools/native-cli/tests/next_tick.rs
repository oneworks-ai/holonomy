use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "holo-next-tick-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn write(&self, name: &str, source: &str) {
        fs::write(self.0.join(name), source).unwrap();
    }

    fn run(&self, entry: &str, configured: bool) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_holo"));
        command.args(["--timeout", "5000"]);
        if configured {
            self.write(
                "host.json",
                r#"{"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2}}"#,
            );
            command.args(["--host-config", "host.json"]);
        }
        command
            .arg(entry)
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

fn success(output: &Output, expected: &str) {
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), expected);
}

#[test]
fn commonjs_drains_tick_fifo_and_nested_before_promise_jobs() {
    let fixture = Fixture::new();
    fixture.write(
        "index.cjs",
        r#"
const assert = require('node:assert/strict');
const order = [];
const identity = { value: 7 };
assert.equal(process.nextTick(function (value, missing) {
  'use strict';
  assert.strictEqual(this, undefined);
  assert.strictEqual(arguments.length, 2);
  assert.strictEqual(value, identity);
  assert.strictEqual(missing, undefined);
  order.push('first');
  process.nextTick(() => order.push('nested'));
}, identity, undefined), undefined);
process.nextTick(() => order.push('second'));
Promise.resolve().then(() => order.push('promise'));
assert.throws(() => process.nextTick(4), TypeError);
setTimeout(() => {
  assert.deepEqual(order, ['first', 'second', 'nested', 'promise']);
  console.log('CJS_TICK_OK');
}, 0);
"#,
    );
    success(&fixture.run("index.cjs", false), "CJS_TICK_OK\n");
}

#[test]
fn commonjs_empty_tick_checkpoint_does_not_run_a_timer() {
    let fixture = Fixture::new();
    fixture.write(
        "index.cjs",
        r#"
const assert = require('node:assert/strict');
const order = [];
Promise.resolve().then(() => order.push('promise'));
setTimeout(() => {
  order.push('timer');
  assert.deepEqual(order, ['promise', 'timer']);
  console.log('EMPTY_TICK_CHECKPOINT_OK');
}, 0);
"#,
    );
    success(
        &fixture.run("index.cjs", false),
        "EMPTY_TICK_CHECKPOINT_OK\n",
    );
}

#[test]
fn promise_jobs_and_ticks_can_rearm_each_other_without_a_timer() {
    let fixture = Fixture::new();
    fixture.write(
        "index.cjs",
        r#"
const assert = require('node:assert/strict');
const order = [];
process.nextTick(() => {
  order.push('tick');
  Promise.resolve().then(() => {
    order.push('promise');
    process.nextTick(() => {
      order.push('from promise');
      assert.deepEqual(order, ['tick', 'promise', 'from promise']);
      console.log('REARMED_TICK_OK');
    });
  });
});
"#,
    );
    success(&fixture.run("index.cjs", false), "REARMED_TICK_OK\n");
}

#[test]
fn esm_top_level_keeps_promise_job_before_tick() {
    let fixture = Fixture::new();
    fixture.write(
        "index.mjs",
        r#"
import assert from 'node:assert/strict';
const order = [];
process.nextTick(() => order.push('tick'));
Promise.resolve().then(() => order.push('promise'));
setTimeout(() => {
  assert.deepEqual(order, ['promise', 'tick']);
  console.log('ESM_TICK_OK');
}, 0);
"#,
    );
    success(&fixture.run("index.mjs", false), "ESM_TICK_OK\n");
}

#[test]
fn commonjs_imported_by_esm_keeps_promise_jobs_before_ticks() {
    let fixture = Fixture::new();
    fixture.write(
        "imported.cjs",
        r#"
const order = globalThis.tickOrder;
order.push('cjs sync');
process.nextTick(() => order.push('cjs tick'));
Promise.resolve().then(() => order.push('cjs promise'));
"#,
    );
    fixture.write(
        "index.mjs",
        r#"
import assert from 'node:assert/strict';
import './setup.mjs';
import './imported.cjs';
const order = globalThis.tickOrder;
order.push('esm sync');
process.nextTick(() => order.push('esm tick'));
Promise.resolve().then(() => order.push('esm promise'));
setTimeout(() => {
  assert.deepEqual(order, [
    'cjs sync', 'esm sync', 'cjs promise', 'esm promise', 'cjs tick', 'esm tick'
  ]);
  console.log('IMPORTED_CJS_TICK_OK');
}, 0);
"#,
    );
    fixture.write("setup.mjs", "globalThis.tickOrder = [];");
    success(&fixture.run("index.mjs", false), "IMPORTED_CJS_TICK_OK\n");
}

#[test]
fn timer_callback_drains_tick_before_its_promise_job() {
    let fixture = Fixture::new();
    fixture.write(
        "index.mjs",
        r#"
import assert from 'node:assert/strict';
const order = [];
setTimeout(() => {
  order.push('timer');
  process.nextTick(() => order.push('tick'));
  Promise.resolve().then(() => order.push('promise'));
}, 0);
setTimeout(() => {
  assert.deepEqual(order, ['timer', 'tick', 'promise']);
  console.log('TIMER_TICK_OK');
}, 20);
"#,
    );
    success(&fixture.run("index.mjs", false), "TIMER_TICK_OK\n");
}

#[test]
fn throwing_tick_is_fatal_and_discards_later_ticks() {
    let fixture = Fixture::new();
    fixture.write(
        "index.cjs",
        r#"
process.nextTick(() => { console.log('THROWING'); throw new Error('tick failed'); });
process.nextTick(() => console.log('LATE'));
"#,
    );
    let start = Instant::now();
    let output = fixture.run("index.cjs", false);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "THROWING\n");
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[test]
fn synchronous_commonjs_failure_discards_queued_ticks() {
    let fixture = Fixture::new();
    fixture.write(
        "index.cjs",
        r#"
process.nextTick(() => console.log('LATE'));
throw new Error('sync fatal');
"#,
    );
    let output = fixture.run("index.cjs", false);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("sync fatal"));
}

#[test]
fn process_exit_discards_later_ticks() {
    let fixture = Fixture::new();
    fixture.write(
        "index.cjs",
        r#"
process.nextTick(() => { console.log('EXITING'); process.exit(7); });
process.nextTick(() => console.log('LATE'));
"#,
    );
    let output = fixture.run("index.cjs", false);
    assert_eq!(output.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "EXITING\n");
}

#[test]
fn recursive_ticks_hit_callback_budget_before_deadline() {
    let fixture = Fixture::new();
    fixture.write(
        "index.cjs",
        r#"
console.log('RECURSING');
let count = 0;
process.nextTick(function again() {
  count++;
  if (count === 1024) console.log('BUDGET_BOUNDARY');
  process.nextTick(again);
});
"#,
    );
    let start = Instant::now();
    let output = fixture.run("index.cjs", false);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "RECURSING\nBUDGET_BOUNDARY\n"
    );
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[test]
fn configured_process_override_uses_same_tick_queue() {
    let fixture = Fixture::new();
    fixture.write(
        "index.cjs",
        r#"
const assert = require('node:assert/strict');
const imported = require('node:process');
assert.strictEqual(imported, process);
const order = [];
imported.nextTick(() => order.push('imported'));
process.nextTick(() => order.push('global'));
Promise.resolve().then(() => order.push('promise'));
setTimeout(() => {
  assert.deepEqual(order, ['imported', 'global', 'promise']);
  console.log('CONFIGURED_TICK_OK');
}, 0);
"#,
    );
    success(&fixture.run("index.cjs", true), "CONFIGURED_TICK_OK\n");
}
