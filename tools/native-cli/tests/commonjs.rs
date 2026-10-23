use serde_json::json;
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
        let directory = std::env::temp_dir().join(format!(
            "holo-commonjs-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        Self(directory)
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

    fn run_configured(&self, entry: &str, source: &str) -> Output {
        fs::write(
            self.0.join("host.json"),
            json!({ "schemaVersion": 1, "sandboxPolicy": { "schemaVersion": 2 } }).to_string(),
        )
        .unwrap();
        fs::write(self.0.join(entry), source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args(["--timeout", "5000", "--host-config", "host.json", entry])
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

fn success(output: &Output, marker: &str) {
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{marker}\n")
    );
}

#[test]
fn synthetic_require_returns_shared_commonjs_values() {
    let fixture = Fixture::new();
    let output = fixture.run(
        "index.js",
        r#"
const assert = require('node:assert/strict');
assert(true);
assert.strictEqual(assert.ok, require('node:assert/strict').ok);
const runtimeProcess = require('node:process');
assert.strictEqual(runtimeProcess, globalThis.process);
runtimeProcess.exitCode = 23;
assert.strictEqual(globalThis.process.exitCode, 23);
globalThis.process.exitCode = 0;
assert.strictEqual(runtimeProcess.exitCode, 0);
const EventEmitter = require('node:events');
assert.strictEqual(typeof EventEmitter, 'function');
assert.strictEqual(EventEmitter.EventEmitter, EventEmitter);
const emitter = new EventEmitter();
let heard = 0;
emitter.on('tick', () => { heard++; });
emitter.emit('tick');
assert.strictEqual(heard, 1);
const path = require('node:path');
assert.strictEqual(path.basename('/a/b'), 'b');
const buffer = require('node:buffer');
assert.strictEqual(buffer.Buffer, globalThis.Buffer);
assert.strictEqual(buffer.Buffer.from('ok').toString(), 'ok');
const test = require('node:test');
assert.strictEqual(typeof test, 'function');
assert.strictEqual(test.it, test);
assert.strictEqual(test.test, test);
assert.strictEqual(typeof test.describe, 'function');
assert.strictEqual(typeof test.before, 'function');
assert.strictEqual(typeof test.run, 'function');
test.describe('suite', () => test('case', () => {}));
console.log('COMMONJS_VALUES_OK');
"#,
    );
    success(&output, "COMMONJS_VALUES_OK");
}

#[test]
fn synthetic_esm_default_and_named_exports_remain_distinct() {
    let fixture = Fixture::new();
    let output = fixture.run(
        "index.mjs",
        r#"
import assert, { strictEqual } from 'node:assert/strict';
import EventEmitter, { EventEmitter as NamedEmitter } from 'node:events';
import path, { basename } from 'node:path';
import buffer, { Buffer } from 'node:buffer';
import runtimeProcess, { cwd } from 'node:process';
import test, { describe, it } from 'node:test';
strictEqual(typeof assert, 'function');
strictEqual(assert.strictEqual, strictEqual);
strictEqual(EventEmitter, NamedEmitter);
strictEqual(EventEmitter.EventEmitter, NamedEmitter);
strictEqual(path.basename, basename);
strictEqual(buffer.Buffer, Buffer);
strictEqual(runtimeProcess, globalThis.process);
strictEqual(typeof cwd, 'function');
strictEqual(test, it);
strictEqual(test.describe, describe);
console.log('ESM_EXPORTS_OK');
"#,
    );
    success(&output, "ESM_EXPORTS_OK");
}

#[test]
fn configured_process_override_keeps_require_and_global_identity() {
    let fixture = Fixture::new();
    let output = fixture.run_configured(
        "index.js",
        r#"
const assert = require('node:assert/strict');
const runtimeProcess = require('node:process');
assert.strictEqual(runtimeProcess, globalThis.process);
runtimeProcess.exitCode = 17;
assert.strictEqual(globalThis.process.exitCode, 17);
globalThis.process.exitCode = 0;
assert.strictEqual(runtimeProcess.exitCode, 0);
console.log('PROCESS_OVERRIDE_OK');
"#,
    );
    success(&output, "PROCESS_OVERRIDE_OK");
}
