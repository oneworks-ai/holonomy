#![cfg(unix)]
use serde_json::Value;
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
        let root = std::env::temp_dir().join(format!(
            "holo-test-files-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn write(&self, name: &str, source: &str) {
        fs::write(self.0.join(name), source).unwrap();
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args(args)
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
fn reports(output: &Output) -> Vec<Value> {
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value.get("results").is_some())
        .collect()
}

#[test]
fn all_explicit_test_files_run_in_isolated_runtimes_and_failure_is_not_hidden() {
    let fixture = Fixture::new();
    fixture.write(
        "first.mjs",
        "import test from 'node:test'; globalThis.otherFile = true; test('first',()=>{});",
    );
    fixture.write(
        "fail.mjs",
        "import test from 'node:test'; test('second',()=>{throw Error('must fail')});",
    );
    fixture.write("last.mjs", "import test from 'node:test'; import assert from 'node:assert/strict'; test('last',()=>assert.equal(globalThis.otherFile,undefined));");
    let output = fixture.run(&[
        "test",
        "--timeout",
        "6000",
        "first.mjs",
        "fail.mjs",
        "last.mjs",
    ]);
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reports = reports(&output);
    assert_eq!(
        reports.len(),
        3,
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        reports
            .iter()
            .map(|r| r["failed"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [0, 1, 0]
    );
}

#[test]
fn extra_missing_file_is_preflighted_before_any_test_executes() {
    let fixture = Fixture::new();
    fixture.write("first.mjs", "console.log('MUST_NOT_RUN');");
    let output = fixture.run(&["test", "first.mjs", "missing.mjs"]);
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("MUST_NOT_RUN"));
}

#[test]
fn early_success_exit_cannot_skip_registered_failing_tests() {
    let fixture = Fixture::new();
    for (name, source) in [
        (
            "before.mjs",
            "import test from 'node:test'; test('must fail',()=>{throw Error('not run')}); process.exit(0);",
        ),
        (
            "inside.mjs",
            "import test from 'node:test'; test('must complete',()=>process.exit(0));",
        ),
    ] {
        fixture.write(name, source);
        let output = fixture.run(&["test", "--timeout", "3000", name]);
        assert_eq!(output.status.code(), Some(1));
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("Test execution terminated before completion")
        );
    }
    fixture.write("run.mjs", "process.exit(0)");
    assert!(fixture.run(&["run.mjs"]).status.success());
}

#[test]
fn timeout_is_shared_across_files_instead_of_reset_for_each_file() {
    let fixture = Fixture::new();
    for name in ["first.mjs", "second.mjs", "third.mjs"] {
        fixture.write(name, "import test from 'node:test'; test('slow',async()=>await new Promise(r=>setTimeout(r,250)));");
    }
    let started = Instant::now();
    let output = fixture.run(&[
        "test",
        "--timeout",
        "500",
        "first.mjs",
        "second.mjs",
        "third.mjs",
    ]);
    assert!(!output.status.success());
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(reports(&output).len() < 3);
}

#[test]
fn run_arguments_still_belong_to_guest_and_tests_accept_more_than_one_success() {
    let fixture = Fixture::new();
    fixture.write("run.mjs", "console.log(process.argv.slice(2).join('|'))");
    let run = fixture.run(&["run.mjs", "one", "--flag"]);
    assert!(run.status.success());
    assert!(String::from_utf8_lossy(&run.stdout).contains("one|--flag"));
    for name in ["a.mjs", "b.mjs"] {
        fixture.write(name, "import test from 'node:test'; test('ok',()=>{});");
    }
    let output = fixture.run(&["test", "--timeout", "5000", "a.mjs", "b.mjs"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(reports(&output).len(), 2);
}
