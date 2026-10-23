//! Public package-import behavior through the standalone Node-free `holo` executable.
//! Rust only creates physical fixtures and observes the child process. Successful
//! module behavior is asserted by the Guest JavaScript in each fixture.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
const MARKER: &str = "PACKAGE_IMPORTS_OK";

struct Fixture {
    root: PathBuf,
    guest: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-package-imports-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let guest = root.join("guest");
        fs::create_dir_all(&guest).unwrap();
        Self { root, guest }
    }

    fn write(&self, path: &str, source: &str) {
        let target = self.guest.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, source).unwrap();
    }

    fn write_owner(&self, path: &str, source: &str) -> PathBuf {
        let target = self.root.join(path);
        fs::write(&target, source).unwrap();
        target
    }

    fn run(&self, entry: &str) -> Output {
        self.run_with_config(entry, None)
    }

    fn run_with_config(&self, entry: &str, config: Option<&Path>) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_holo"));
        command.arg("--timeout").arg("4000");
        if let Some(config) = config {
            command.arg("--host-config").arg(config);
        }
        command
            .arg(entry)
            .env_clear()
            .env("PATH", "")
            .current_dir(&self.guest)
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn successful(output: Output) {
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, format!("{MARKER}\n").as_bytes());
}

fn rejected(output: Output, code: &str) {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(
        output.status.code(),
        Some(1),
        "stdout: {stdout}\nstderr: {stderr}"
    );
    assert!(stdout.is_empty(), "Guest code ran unexpectedly: {stdout}");
    assert!(stderr.contains(code), "missing {code}: {stderr}");
}

#[test]
fn single_utf8_bom_package_scope_and_json_use_the_shared_decoder() {
    let f = Fixture::new();
    f.write("package.json", "\u{feff}{\"type\":\"module\"}");
    f.write("data.JSON", "\u{feff}{\"answer\":42}");
    f.write(
        "index.js",
        &format!(
            "import data from './data.JSON'; if (data.answer !== 42) throw Error('JSON changed'); console.log('{MARKER}');"
        ),
    );
    successful(f.run("index.js"));
}

#[test]
fn esm_static_and_dynamic_local_aliases_share_one_module_identity() {
    let f = Fixture::new();
    f.write(
        "package.json",
        r##"{"type":"module","imports":{"#static":"./static.mjs","#same":"./static.mjs","#dynamic":"./dynamic.mjs"}}"##,
    );
    f.write(
        "static.mjs",
        "globalThis.staticRuns=(globalThis.staticRuns??0)+1;export const answer=42;",
    );
    f.write(
        "dynamic.mjs",
        "globalThis.dynamicRuns=(globalThis.dynamicRuns??0)+1;export const mode='dynamic';",
    );
    f.write(
        "entry.mjs",
        r##"
import assert from 'node:assert/strict';
import * as first from '#static';
import * as second from '#same';
assert.strictEqual(first, second);
assert.equal(first.answer, 42);
assert.equal(globalThis.staticRuns, 1);
const alias = '#dynamic';
const dynamicFirst = await import(alias);
const dynamicSecond = await import(alias);
assert.strictEqual(dynamicFirst, dynamicSecond);
assert.equal(dynamicFirst.mode, 'dynamic');
assert.equal(globalThis.dynamicRuns, 1);
console.log('PACKAGE_IMPORTS_OK');
"##,
    );
    successful(f.run("entry.mjs"));
}

#[test]
fn commonjs_require_and_resolve_aliases_keep_resolve_only_unexecuted() {
    let f = Fixture::new();
    f.write(
        "package.json",
        r##"{"imports":{"#only":"./resolve-only.cjs","#run":"./run.cjs","#again":"./run.cjs"}}"##,
    );
    f.write(
        "resolve-only.cjs",
        "globalThis.resolveOnlyRan=true;module.exports=1;",
    );
    f.write(
        "run.cjs",
        "globalThis.runCount=(globalThis.runCount??0)+1;module.exports={value:7};",
    );
    f.write(
        "entry.cjs",
        r##"
const assert = require('node:assert/strict');
assert.equal(require.resolve('#only'), 'app://workspace/resolve-only.cjs');
assert.equal(globalThis.resolveOnlyRan, undefined);
const first = require('#run');
const second = require('#again');
assert.strictEqual(first, second);
assert.strictEqual(require('#run'), first);
assert.equal(first.value, 7);
assert.equal(globalThis.runCount, 1);
const alias = require;
let denied = false;
try {
  alias('#only');
} catch (error) {
  assert.equal(error.code, 'ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED');
  denied = true;
}
assert.equal(denied, true);
assert.equal(globalThis.resolveOnlyRan, undefined);
console.log('PACKAGE_IMPORTS_OK');
"##,
    );
    successful(f.run("entry.cjs"));
}

#[test]
fn import_require_and_default_conditions_follow_manifest_order() {
    let f = Fixture::new();
    f.write(
        "package.json",
        r##"{"type":"module","imports":{"#choice":{"require":"./require.cjs","import":"./import.mjs","default":"./default.cjs"},"#default-first":{"default":"./default.cjs","import":"./import.mjs","require":"./require.cjs"}}}"##,
    );
    f.write("import.mjs", "export const selected='import';");
    f.write("require.cjs", "module.exports={selected:'require'};");
    f.write("default.cjs", "module.exports={selected:'default'};");
    f.write(
        "client.cjs",
        r##"module.exports={choice:require('#choice'),defaultFirst:require('#default-first'),choiceUrl:require.resolve('#choice')};"##,
    );
    f.write(
        "entry.mjs",
        r##"
import assert from 'node:assert/strict';
import { selected as imported } from '#choice';
import defaultFirst from '#default-first';
import client from './client.cjs';
assert.equal(imported, 'import');
assert.equal(client.choice.selected, 'require');
assert.equal(client.choiceUrl, 'app://workspace/require.cjs');
assert.equal(defaultFirst.selected, 'default');
assert.strictEqual(defaultFirst, client.defaultFirst);
console.log('PACKAGE_IMPORTS_OK');
"##,
    );
    successful(f.run("entry.mjs"));
}

#[test]
fn exact_alias_beats_patterns_and_longer_pattern_beats_shorter() {
    let f = Fixture::new();
    f.write(
        "package.json",
        r##"{"type":"module","imports":{"#feature/*":"./generic/*.mjs","#feature/deep/*":"./deep/*.mjs","#feature/deep/exact":"./exact.mjs"}}"##,
    );
    f.write("generic/other.mjs", "export const selected='generic';");
    f.write("generic/deep/item.mjs", "export const selected='wrong';");
    f.write("deep/item.mjs", "export const selected='deep';");
    f.write("deep/exact.mjs", "export const selected='wrong';");
    f.write("exact.mjs", "export const selected='exact';");
    f.write(
        "entry.mjs",
        r##"
import assert from 'node:assert/strict';
import { selected as generic } from '#feature/other';
import { selected as deep } from '#feature/deep/item';
import { selected as exact } from '#feature/deep/exact';
assert.deepEqual([generic, deep, exact], ['generic', 'deep', 'exact']);
console.log('PACKAGE_IMPORTS_OK');
"##,
    );
    successful(f.run("entry.mjs"));
}

#[test]
fn external_local_package_targets_use_the_physical_packages_exports() {
    let f = Fixture::new();
    f.write(
        "package.json",
        r##"{"type":"module","imports":{"#dependency":"actual/sub","#private":"actual/private"}}"##,
    );
    f.write(
        "node_modules/actual/package.json",
        r##"{"exports":{"./sub":{"import":"./import.mjs","require":"./require.cjs"}}}"##,
    );
    f.write(
        "node_modules/actual/import.mjs",
        "export const selected='import';",
    );
    f.write(
        "node_modules/actual/require.cjs",
        "module.exports={selected:'require'};",
    );
    f.write("client.cjs", r##"module.exports=require('#dependency');"##);
    f.write(
        "entry.mjs",
        r##"
import assert from 'node:assert/strict';
import { selected } from '#dependency';
import client from './client.cjs';
assert.equal(selected, 'import');
assert.equal(client.selected, 'require');
console.log('PACKAGE_IMPORTS_OK');
"##,
    );
    successful(f.run("entry.mjs"));

    f.write(
        "blocked.mjs",
        "import '#private'; console.log('SHOULD_NOT_RUN');",
    );
    rejected(f.run("blocked.mjs"), "ERR_PACKAGE_PATH_NOT_EXPORTED");
}

#[test]
fn builtin_aliases_reach_only_declared_synthetic_modules() {
    let f = Fixture::new();
    f.write(
        "package.json",
        r##"{"type":"module","imports":{"#path":"path","#assert":"assert/strict","#scheme":"node:path"}}"##,
    );
    f.write(
        "client.cjs",
        r##"const assert=require('#assert');module.exports={same:assert.strictEqual===require('node:assert/strict').strictEqual,pathUrl:require.resolve('#path')};"##,
    );
    f.write(
        "entry.mjs",
        r##"
import assert from 'node:assert/strict';
import path from '#path';
import client from './client.cjs';
assert.equal(path.basename('/one/two'), 'two');
assert.equal(client.same, true);
assert.equal(client.pathUrl, 'node:path');
console.log('PACKAGE_IMPORTS_OK');
"##,
    );
    successful(f.run("entry.mjs"));

    f.write(
        "scheme.mjs",
        "import '#scheme'; console.log('SHOULD_NOT_RUN');",
    );
    rejected(f.run("scheme.mjs"), "ERR_INVALID_PACKAGE_TARGET");
}

#[test]
fn nearest_package_scope_shields_outer_imports_and_node_modules_stops_lookup() {
    let f = Fixture::new();
    f.write(
        "package.json",
        r##"{"type":"module","imports":{"#scope":"./root.mjs","#root-only":"./root.mjs"}}"##,
    );
    f.write("root.mjs", "export const source='root';");
    f.write(
        "nested/package.json",
        r##"{"type":"module","imports":{"#scope":"./nested.mjs"}}"##,
    );
    f.write("nested/nested.mjs", "export const source='nested';");
    f.write(
        "nested/entry.mjs",
        r##"import {source} from '#scope'; export default source;"##,
    );
    f.write(
        "entry.mjs",
        r##"
import assert from 'node:assert/strict';
import { source as root } from '#scope';
import nested from './nested/entry.mjs';
assert.equal(root, 'root');
assert.equal(nested, 'nested');
console.log('PACKAGE_IMPORTS_OK');
"##,
    );
    successful(f.run("entry.mjs"));

    f.write(
        "nested/blocked.mjs",
        "import '#root-only'; console.log('SHOULD_NOT_RUN');",
    );
    rejected(
        f.run("nested/blocked.mjs"),
        "ERR_PACKAGE_IMPORT_NOT_DEFINED",
    );

    f.write(
        "node_modules/inner/package.json",
        r##"{"type":"module","exports":"./index.mjs"}"##,
    );
    f.write("node_modules/inner/index.mjs", "import '#scope';");
    f.write(
        "from-package.mjs",
        "import 'inner'; console.log('SHOULD_NOT_RUN');",
    );
    rejected(f.run("from-package.mjs"), "ERR_PACKAGE_IMPORT_NOT_DEFINED");
}

#[test]
fn null_and_missing_aliases_fail_with_the_public_import_error() {
    let f = Fixture::new();
    f.write(
        "package.json",
        r##"{"imports":{"#blocked":null,"#blocked/*":null}}"##,
    );
    for (entry, specifier) in [
        ("null.cjs", "#blocked"),
        ("null-pattern.cjs", "#blocked/child"),
        ("missing.cjs", "#missing"),
    ] {
        f.write(
            entry,
            &format!("require('{specifier}'); console.log('SHOULD_NOT_RUN');"),
        );
        rejected(f.run(entry), "ERR_PACKAGE_IMPORT_NOT_DEFINED");
    }
}

#[test]
fn dynamic_missing_and_blocked_aliases_reject_with_public_error_codes() {
    let f = Fixture::new();
    f.write(
        "package.json",
        r##"{"type":"module","imports":{"#blocked":null}}"##,
    );
    f.write(
        "entry.mjs",
        r##"
import assert from 'node:assert/strict';
for (const alias of ['#missing', '#blocked']) {
  let rejected = false;
  try {
    await import(alias);
  } catch (error) {
    assert.equal(error.code, 'ERR_PACKAGE_IMPORT_NOT_DEFINED');
    rejected = true;
  }
  assert.equal(rejected, true);
}
console.log('PACKAGE_IMPORTS_OK');
"##,
    );
    successful(f.run("entry.mjs"));
}

#[test]
fn malformed_imports_map_is_rejected_before_guest_execution() {
    let f = Fixture::new();
    f.write("package.json", r##"{"imports":["./target.mjs"]}"##);
    f.write("target.mjs", "console.log('SHOULD_NOT_RUN');");
    f.write(
        "entry.mjs",
        "import '#target'; console.log('SHOULD_NOT_RUN');",
    );
    rejected(
        f.run("entry.mjs"),
        "ERR_HOLONOMY_MODULE_INVALID_PACKAGE_CONFIG",
    );
}

#[test]
fn malformed_hash_specifiers_are_rejected_before_guest_execution() {
    let f = Fixture::new();
    f.write("package.json", r##"{"type":"module","imports":{}}"##);
    for (entry, specifier) in [("hash.mjs", "#"), ("hash-slash.mjs", "#/child")] {
        f.write(
            entry,
            &format!("import '{specifier}'; console.log('SHOULD_NOT_RUN');"),
        );
        rejected(f.run(entry), "ERR_INVALID_MODULE_SPECIFIER");
    }
}

#[test]
fn import_targets_cannot_escape_guest_root_or_read_owner_private_sources() {
    let f = Fixture::new();
    let config = f.write_owner(
        "owner-host.json",
        r##"{"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"context":{"schemaVersion":1,"host":{"secret":"HOST_ONLY_TEST_VALUE"}}}"##,
    );
    f.write_owner("secret.mjs", "console.log('SECRET_EXECUTED');");
    f.write(
        "package.json",
        &format!(
            r##"{{"type":"module","imports":{{"#escape":"../secret.mjs","#traverse":"./../secret.mjs","#private":"../owner-host.json","#scheme":"holonomy:///runtime/private.mjs","#file":"file://{}"}}}}"##,
            f.root.join("secret.mjs").display()
        ),
    );
    for (entry, specifier) in [
        ("escape.mjs", "#escape"),
        ("traverse.mjs", "#traverse"),
        ("private.mjs", "#private"),
        ("scheme.mjs", "#scheme"),
        ("file.mjs", "#file"),
    ] {
        f.write(
            entry,
            &format!("import '{specifier}'; console.log('SHOULD_NOT_RUN');"),
        );
        let output = f.run_with_config(entry, Some(&config));
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(1), "{entry}: {stdout}\n{stderr}");
        assert!(stdout.is_empty(), "{entry}: {stdout}");
        assert!(
            stderr.contains("ERR_INVALID_PACKAGE_TARGET"),
            "{entry}: {stderr}"
        );
        assert!(
            !stderr.contains("HOST_ONLY_TEST_VALUE"),
            "{entry}: {stderr}"
        );
        assert!(!stderr.contains("SECRET_EXECUTED"), "{entry}: {stderr}");
    }
}

#[test]
fn aliases_that_form_a_cycle_fail_within_the_runtime_deadline() {
    let f = Fixture::new();
    f.write(
        "package.json",
        r##"{"type":"module","imports":{"#a":"#b","#b":"#a"}}"##,
    );
    f.write("entry.mjs", "import '#a'; console.log('SHOULD_NOT_RUN');");
    let start = Instant::now();
    let output = f.run("entry.mjs");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "{stderr}");
    assert!(output.stdout.is_empty());
    assert!(stderr.contains("ERR_"), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");
    assert!(
        start.elapsed() < Duration::from_secs(4),
        "cycle hit CLI timeout: {stderr}"
    );
}

#[test]
fn imports_and_exports_targets_are_exact_and_physical_extensionless_js_is_supported() {
    let f = Fixture::new();
    f.write("package.json", r##"{"type":"module","imports":{"#exact":"./target","#directory":"./directory","#dependency":"dep"}}"##);
    f.write(
        "target.mjs",
        "console.log('WRONG_EXTENSION_FALLBACK'); export default 1",
    );
    f.write(
        "entry.mjs",
        "import '#exact'; console.log('SHOULD_NOT_RUN')",
    );
    rejected(f.run("entry.mjs"), "ERR_HOLONOMY_MODULE_NOT_FOUND");
    f.write("target", "export default 42");
    f.write("entry.mjs", "import assert from 'node:assert/strict'; import value from '#exact'; assert.equal(value,42); console.log('PACKAGE_IMPORTS_OK')");
    successful(f.run("entry.mjs"));
    f.write(
        "directory/index.mjs",
        "console.log('WRONG_DIRECTORY_FALLBACK'); export default 1",
    );
    f.write(
        "entry.mjs",
        "import '#directory'; console.log('SHOULD_NOT_RUN')",
    );
    // A permitted directory is a missing file candidate. It must not silently
    // select index.mjs or leak the native path.
    let result = f.run("entry.mjs");
    assert!(!String::from_utf8_lossy(&result.stderr).contains(f.guest.to_str().unwrap()));
    rejected(result, "ERR_HOLONOMY_MODULE_NOT_FOUND");
    f.write(
        "node_modules/dep/package.json",
        r#"{"type":"module","exports":"./missing"}"#,
    );
    f.write(
        "node_modules/dep/missing.mjs",
        "console.log('WRONG_EXPORT_FALLBACK'); export default 1",
    );
    f.write(
        "entry.mjs",
        "import '#dependency'; console.log('SHOULD_NOT_RUN')",
    );
    rejected(f.run("entry.mjs"), "ERR_HOLONOMY_MODULE_NOT_FOUND");
}

#[test]
fn unmatched_array_conditions_fall_through_and_unused_keys_do_not_poison_imports() {
    let f = Fixture::new();
    f.write("package.json", r##"{"type":"module","imports":{"bare":"../ignored","#choice":{"import":[{"custom":"./unused.mjs"}],"default":"./value.mjs"}}}"##);
    f.write("value.mjs", "export default 42");
    f.write("entry.mjs", "import assert from 'node:assert/strict'; import value from '#choice'; assert.equal(value,42); console.log('PACKAGE_IMPORTS_OK')");
    successful(f.run("entry.mjs"));
    f.write("package.json", r#"{"type":"module","imports":null}"#);
    rejected(f.run("entry.mjs"), "ERR_PACKAGE_IMPORT_NOT_DEFINED");
}
