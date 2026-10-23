//! Exact local ESM paths through the standalone Node-free Rust/V8 executable.
//! Fixture setup and process status are Host assertions; module values and
//! dynamic import behavior are asserted by Guest JavaScript.

#![cfg(unix)]

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
            "holo-relative-esm-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }

    fn write(&self, name: &str, source: &str) {
        let path = self.0.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, source).unwrap();
    }

    fn run(&self, entry: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args(["--timeout", "5000", entry])
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

fn successful(output: Output, marker: &str) {
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, format!("{marker}\n").as_bytes());
}

fn rejected(output: Output, code: &str) {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "{stderr}");
    assert!(
        output.stdout.is_empty(),
        "unexpected Guest output: {:?}",
        output.stdout
    );
    assert!(stderr.contains(code), "missing {code}: {stderr}");
}

#[test]
fn esm_relative_import_does_not_probe_extension_or_directory_index() {
    let fixture = Fixture::new();
    fixture.write("package.json", r#"{"type":"module"}"#);
    fixture.write(
        "file.js",
        "console.log('WRONG_FILE_FALLBACK'); export default 1",
    );
    fixture.write(
        "entry-file.mjs",
        "import './file'; console.log('SHOULD_NOT_RUN')",
    );
    rejected(
        fixture.run("entry-file.mjs"),
        "ERR_HOLONOMY_MODULE_NOT_FOUND",
    );

    fixture.write(
        "directory/index.js",
        "console.log('WRONG_DIRECTORY_FALLBACK'); export default 1",
    );
    fixture.write(
        "entry-directory.mjs",
        "import './directory'; console.log('SHOULD_NOT_RUN')",
    );
    // An authorized directory is a missing file candidate, never an index.
    rejected(
        fixture.run("entry-directory.mjs"),
        "ERR_HOLONOMY_MODULE_NOT_FOUND",
    );
}

#[test]
fn esm_relative_import_selects_a_physical_extensionless_file() {
    let fixture = Fixture::new();
    fixture.write("package.json", r#"{"type":"module"}"#);
    fixture.write("physical", "export default 42");
    fixture.write(
        "physical.js",
        "console.log('WRONG_PHYSICAL_FALLBACK'); export default 1",
    );
    fixture.write(
        "entry.mjs",
        r#"
            import assert from 'node:assert/strict';
            import value from './physical';
            assert.equal(value, 42);
            const dynamic = await import('./physical');
            assert.equal(dynamic.default, 42);
            console.log('EXACT_ESM_OK');
        "#,
    );
    successful(fixture.run("entry.mjs"), "EXACT_ESM_OK");
}

#[test]
fn esm_dynamic_relative_import_does_not_probe_an_extension() {
    let fixture = Fixture::new();
    fixture.write("package.json", r#"{"type":"module"}"#);
    fixture.write(
        "late.js",
        "console.log('WRONG_DYNAMIC_FALLBACK'); export default 1",
    );
    fixture.write(
        "entry.mjs",
        "await import('./late'); console.log('SHOULD_NOT_RUN')",
    );
    rejected(fixture.run("entry.mjs"), "ERR_HOLONOMY_MODULE_NOT_FOUND");
}

#[test]
fn esm_missing_dynamic_import_rejects_to_guest_catch() {
    let fixture = Fixture::new();
    fixture.write("package.json", r#"{"type":"module"}"#);
    fixture.write("late.js", "console.log('WRONG_DYNAMIC_FALLBACK')");
    fixture.write(
        "entry.mjs",
        r#"
            import assert from 'node:assert/strict';
            let caught = false;
            try { await import('./late'); }
            catch (error) {
                assert.equal(error.code, 'ERR_HOLONOMY_MODULE_NOT_FOUND');
                caught = true;
            }
            assert.equal(caught, true);
            console.log('DYNAMIC_CATCH_OK');
        "#,
    );
    successful(fixture.run("entry.mjs"), "DYNAMIC_CATCH_OK");
}

#[test]
fn commonjs_relative_require_keeps_legacy_file_and_directory_fallback() {
    let fixture = Fixture::new();
    fixture.write("package.json", r#"{"type":"commonjs"}"#);
    fixture.write("file.js", "module.exports = { answer: 42 }");
    fixture.write("physical", "module.exports = { answer: 43 }");
    fixture.write("physical.js", "module.exports = { answer: 1 }");
    fixture.write("directory/.js", "module.exports = { answer: 0 }");
    fixture.write("directory/index.js", "module.exports = { answer: 42 }");
    fixture.write(
        "entry.cjs",
        r#"
            const assert = require('node:assert/strict');
            assert.equal(require('./file').answer, 42);
            assert.equal(require('./physical').answer, 43);
            assert.equal(require('./directory/').answer, 42);
            console.log('CJS_FALLBACK_OK');
        "#,
    );
    successful(fixture.run("entry.cjs"), "CJS_FALLBACK_OK");
}
