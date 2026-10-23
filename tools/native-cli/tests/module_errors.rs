#![cfg(unix)]
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-module-errors-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn write(&self, name: &str, source: &str) {
        fs::write(self.0.join(name), source).unwrap();
    }
    fn error(&self) -> String {
        let output = Command::new(env!("CARGO_BIN_EXE_holo"))
            .args(["--timeout", "3000", "entry.mjs"])
            .current_dir(&self.0)
            .env_clear()
            .env("PATH", "")
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        let error = String::from_utf8_lossy(&output.stderr).into_owned();
        assert!(!error.contains(self.0.to_str().unwrap()), "{error}");
        assert!(!error.contains("PRIVATE_MODULE_SOURCE"), "{error}");
        error
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn module_plan_failures_report_safe_distinct_shared_codes() {
    let fixture = Fixture::new();
    fixture.write("entry.mjs", "import 'missing-package'");
    assert!(fixture.error().contains("ERR_HOLONOMY_MODULE_NOT_FOUND"));
    fixture.write("entry.mjs", "import './broken.mjs'");
    fixture.write(
        "broken.mjs",
        "PRIVATE_MODULE_SOURCE this is invalid syntax !!",
    );
    assert!(
        fixture
            .error()
            .contains("ERR_HOLONOMY_MODULE_SOURCE_INVALID")
    );
    fs::create_dir_all(fixture.0.join("node_modules/pkg")).unwrap();
    fixture.write(
        "node_modules/pkg/package.json",
        r#"{"type":"module","exports":{".":"./index.js"}}"#,
    );
    fixture.write("node_modules/pkg/index.js", "export default 1");
    fixture.write("entry.mjs", "import 'pkg/private'");
    assert!(fixture.error().contains("ERR_PACKAGE_PATH_NOT_EXPORTED"));
}

#[test]
fn dynamic_import_rejects_a_receiving_realm_error_with_own_safe_code() {
    let fixture = Fixture::new();
    fixture.write(
        "entry.mjs",
        r#"
        import assert from 'node:assert/strict';
        let prototypeCallbacks = 0;
        Object.defineProperty(Error.prototype, 'code', {
          configurable: true,
          get() { prototypeCallbacks++; throw new Error('prototype getter'); },
          set() { prototypeCallbacks++; throw new Error('prototype setter'); }
        });
        for (const [specifier, code] of [
          ['absent-dynamic-package', 'ERR_HOLONOMY_MODULE_NOT_FOUND'],
          ['./absent-dynamic.mjs', 'ERR_HOLONOMY_MODULE_NOT_FOUND'],
          ['file:///PRIVATE_MODULE_SOURCE.mjs', 'ERR_HOLONOMY_MODULE_PATH_ESCAPE']
        ]) {
          let rejected;
          try { await import(specifier); } catch (error) { rejected = error; }
          assert.ok(rejected instanceof Error);
          assert.equal(Object.getOwnPropertyDescriptor(rejected, 'code').value, code);
          assert.equal(rejected.message, code);
          assert.equal(prototypeCallbacks, 0);
        }
        console.log('DYNAMIC_IMPORT_SAFE_ERROR_OK');
    "#,
    );
    let output = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args(["--timeout", "3000", "entry.mjs"])
        .current_dir(&fixture.0)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("DYNAMIC_IMPORT_SAFE_ERROR_OK"));
}
