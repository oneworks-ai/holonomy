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
            "holo-module-root-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }
    fn write(&self, name: &str, content: &str) {
        let path = self.0.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args(args)
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
fn successful(output: &Output) {
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
fn nested_project(f: &Fixture) {
    f.write("project/package.json", r#"{"type":"module"}"#);
    f.write("project/shared.mjs", "export const local=40;");
    f.write(
        "project/node_modules/demo/package.json",
        r#"{"name":"demo","type":"module","main":"lib/index.js"}"#,
    );
    f.write(
        "project/node_modules/demo/lib/index.js",
        "export const answer=2;",
    );
    f.write(
        "project/src/index.js",
        r#"
      import assert from 'node:assert/strict';
      import {local} from '../shared.mjs';
      import {answer} from 'demo';
      assert.equal(local+answer,42);
      assert.equal(process.versions.node,undefined);
      assert.equal(import.meta.url,'app://workspace/src/index.js');
      assert.equal(process.argv[1],'app://workspace/src/index.js');
      console.log('NESTED_MODULE_ROOT_OK');
    "#,
    );
}

#[test]
fn explicit_module_root_runs_nested_project_imports_and_bare_packages() {
    let f = Fixture::new();
    nested_project(&f);
    let output = f.run(&[
        "--timeout",
        "5000",
        "--module-root",
        "project",
        "project/src/index.js",
    ]);
    successful(&output);
    assert_eq!(output.stdout, b"NESTED_MODULE_ROOT_OK\n");
}

#[test]
fn default_source_root_is_not_implicitly_widened() {
    let f = Fixture::new();
    nested_project(&f);
    let output = f.run(&["--timeout", "5000", "project/src/index.js"]);
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("NESTED_MODULE_ROOT_OK"));
}

#[test]
fn module_root_option_after_entry_remains_guest_argv() {
    let f = Fixture::new();
    f.write(
        "entry.mjs",
        "console.log(JSON.stringify(process.argv.slice(2)));",
    );
    let output = f.run(&["entry.mjs", "--module-root", "project"]);
    successful(&output);
    assert_eq!(output.stdout, b"[\"--module-root\",\"project\"]\n");
}

#[test]
fn every_test_operand_is_preflighted_inside_the_selected_root() {
    let f = Fixture::new();
    f.write(
        "project/tests/first.mjs",
        "console.log('MUST_NOT_RUN');import {it} from 'node:test';it('one',()=>{});",
    );
    f.write("outside.mjs", "console.log('OUTSIDE_MUST_NOT_RUN');");
    let output = f.run(&[
        "test",
        "--module-root",
        "project",
        "project/tests/first.mjs",
        "outside.mjs",
    ]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("outside selected module root"));
    assert!(output.stdout.is_empty());
}

#[test]
fn test_files_keep_project_relative_urls_under_one_explicit_root() {
    let f = Fixture::new();
    f.write("project/shared.mjs", "export const value=42;");
    for name in ["first", "second"] {
        f.write(&format!("project/tests/{name}.mjs"),&format!(
          "import {{it}} from 'node:test';import assert from 'node:assert/strict';import {{value}} from '../shared.mjs';it('{name}',()=>{{assert.equal(value,42);assert.equal(import.meta.url,'app://workspace/tests/{name}.mjs');}});"
        ));
    }
    let output = f.run(&[
        "test",
        "--timeout",
        "5000",
        "--module-root",
        "project",
        "project/tests/first.mjs",
        "project/tests/second.mjs",
    ]);
    successful(&output);
    let reports = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(reports.len(), 2);
    assert!(
        reports
            .iter()
            .all(|report| report["passed"] == 1 && report["failed"] == 0)
    );
}

#[cfg(unix)]
#[test]
fn escaping_entry_symlink_is_rejected_before_guest_execution() {
    let f = Fixture::new();
    f.write("project/src/placeholder.mjs", "");
    f.write("outside.mjs", "console.log('ESCAPED_ENTRY');");
    std::os::unix::fs::symlink(f.0.join("outside.mjs"), f.0.join("project/src/alias.mjs")).unwrap();
    let output = f.run(&["--module-root", "project", "project/src/alias.mjs"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("outside selected module root"));
    assert!(output.stdout.is_empty());
}

#[test]
fn wider_module_namespace_does_not_declassify_host_configuration_or_plugin() {
    let f = Fixture::new();
    f.write("project/host.json",r#"{"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"context":{"schemaVersion":1,"host":{"secret":"HOST_ROOT_PRIVATE_SENTINEL"}},"plugins":[{"id":"owner","use":"./plugin.mjs"}]}"#);
    f.write(
        "project/plugin.mjs",
        "export default ()=>{};export const secret='HOST_PLUGIN_PRIVATE_SENTINEL';",
    );
    for target in ["host.json", "plugin.mjs"] {
        f.write(
            "project/src/private.mjs",
            &format!("import value from '../{target}';console.log('PRIVATE_IMPORTED',value);"),
        );
        let output = f.run(&[
            "--timeout",
            "5000",
            "--host-config",
            "project/host.json",
            "--module-root",
            "project",
            "project/src/private.mjs",
        ]);
        assert!(!output.status.success());
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            text.contains("ERR_HOLONOMY_MODULE_HOST_READ_FAILED"),
            "{text}"
        );
        assert!(
            !text.contains("HOST_ROOT_PRIVATE_SENTINEL")
                && !text.contains("HOST_PLUGIN_PRIVATE_SENTINEL")
        );
        assert!(!text.contains("PRIVATE_IMPORTED"));
    }
}

#[test]
fn invalid_root_selection_is_rejected_as_cli_input() {
    let f = Fixture::new();
    f.write("entry.mjs", "console.log('NO_ENTRY');");
    for args in [
        vec!["--module-root"],
        vec!["--module-root", "missing", "entry.mjs"],
        vec!["--module-root", "entry.mjs", "entry.mjs"],
        vec!["--module-root", ".", "--module-root", ".", "entry.mjs"],
    ] {
        let output = f.run(&args);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("module root"));
        assert!(output.stdout.is_empty());
    }
}
