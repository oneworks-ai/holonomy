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
        let path = std::env::temp_dir().join(format!(
            "holo-source-privacy-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn write(&self, path: &str, text: &str) {
        fs::write(self.0.join(path), text).unwrap();
    }
    fn config(&self, plugins: serde_json::Value) {
        self.write("settings.json", &json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"context":{"schemaVersion":1,"host":{"marker":"HOST_ONLY_TEST_VALUE"},"guest":{"public":true}},"plugins":plugins}).to_string());
    }
    fn run(&self, entry: &str, config: &str) -> Output {
        self.run_name(entry, config, "entry.mjs")
    }
    fn run_name(&self, entry: &str, config: &str, name: &str) -> Output {
        self.write(name, entry);
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args(["--timeout", "5000", "--host-config", config, name])
            .current_dir(&self.0)
            .env_clear()
            .output()
            .unwrap()
    }
    fn denied(&self, entry: &str) {
        let output = self.run(entry, "settings.json");
        assert!(
            !output.status.success(),
            "unexpected success: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(
            output.stdout.is_empty(),
            "source or user code leaked: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(!String::from_utf8_lossy(&output.stderr).contains("HOST_ONLY_TEST_VALUE"));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn host_configuration_is_private_across_url_and_filesystem_aliases() {
    let f = Fixture::new();
    f.config(json!([]));
    fs::hard_link(f.0.join("settings.json"), f.0.join("alias.json")).unwrap();
    std::os::unix::fs::symlink("settings.json", f.0.join("link.json")).unwrap();
    for path in [
        "./settings.json",
        "./settings.json?alias=1",
        "./settings.json#alias",
        "./%73ettings.json",
        "./alias.json",
        "./link.json",
    ] {
        f.denied(&format!(
            "import value from '{path}'; console.log(value.context.host.marker);"
        ));
    }
}

#[test]
fn external_host_configuration_hardlink_is_private() {
    let f = Fixture::new();
    let outside = Fixture::new();
    outside.config(json!([]));
    let positive = f.run(
        "console.log('EXTERNAL_CONFIG_OK');",
        outside.0.join("settings.json").to_str().unwrap(),
    );
    assert!(
        positive.status.success(),
        "{}",
        String::from_utf8_lossy(&positive.stderr)
    );
    fs::hard_link(outside.0.join("settings.json"), f.0.join("alias.json")).unwrap();
    let output = f.run(
        "import value from './alias.json'; console.log(value.context.host.marker);",
        outside.0.join("settings.json").to_str().unwrap(),
    );
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn ordinary_json_and_same_directory_file_plugin_remain_usable() {
    let f = Fixture::new();
    f.config(json!([{"id":"private","use":"./plugin.mjs"}]));
    f.write(
        "plugin.mjs",
        "import './dependency.mjs'; export default () => {}; ",
    );
    f.write("dependency.mjs", "export const hostOnly = 1;");
    f.write("public.json", "{\"public\":true}");
    f.write("host.json", "{\"public\":true}");
    let output = f.run("import value from './public.json'; import namedHost from './host.json'; import assert from 'node:assert/strict'; assert.equal(value.public,true); assert.equal(namedHost.public,true); console.log('PUBLIC_OK');", "settings.json");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"PUBLIC_OK\n");
}

#[test]
fn plugin_entry_and_transitive_dependency_cannot_be_guest_modules() {
    let f = Fixture::new();
    f.config(json!([{"id":"private","use":"./plugin.mjs"}]));
    f.write(
        "plugin.mjs",
        "import './dependency.mjs'; console.log('HOST_MUST_NOT_RUN'); export default () => {}; ",
    );
    f.write(
        "dependency.mjs",
        "export const marker='HOST_ONLY_TEST_VALUE';",
    );
    fs::hard_link(f.0.join("dependency.mjs"), f.0.join("alias.mjs")).unwrap();
    for path in [
        "./plugin.mjs",
        "./dependency.mjs",
        "./alias.mjs",
        "./dependency.mjs?alias=1",
    ] {
        f.denied(&format!(
            "import * as value from '{path}'; console.log(value);"
        ));
    }
}

#[test]
fn package_manifest_and_schema_cannot_be_guest_json() {
    let f = Fixture::new();
    fs::create_dir_all(f.0.join("node_modules/private")).unwrap();
    f.config(json!([{"id":"private","use":"private"}]));
    f.write("node_modules/private/package.json", r#"{"holo":{"kind":"runtime-plugin","apiVersion":1,"entry":"./index.mjs","configSchema":"./schema.json"}}"#);
    f.write("node_modules/private/schema.json", r#"{"type":"object"}"#);
    f.write("node_modules/private/index.mjs", "export default () => {};");
    for path in [
        "./node_modules/private/package.json",
        "./node_modules/private/schema.json",
    ] {
        f.denied(&format!("import value from '{path}'; console.log(value);"));
    }
}

#[test]
fn public_configuration_cannot_forge_private_source_bindings() {
    let f = Fixture::new();
    f.write(
        "settings.json",
        r#"{"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"privateSources":[]}"#,
    );
    f.denied("console.log('GUEST_MUST_NOT_RUN');");
}

#[test]
fn allowed_dynamic_import_still_cannot_read_host_source_or_source_url_alias() {
    let f = Fixture::new();
    f.write("settings.json", &json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2,"codeGeneration":{"strings":{"access":"none"},"wasm":{"access":"none"},"dynamicImport":{"access":"controlled","maxSourceBytes":65536,"maxOperations":16,"decisionTimeoutMs":1000}}},"context":{"schemaVersion":1,"host":{"marker":"HOST_ONLY_TEST_VALUE"}},"plugins":[{"id":"allow","use":"./allow.mjs"}]}).to_string());
    f.write(
        "allow.mjs",
        "export default c => { c.holo.engineGate(() => ({action:'allow'})); };",
    );
    f.write("public.mjs", "export const value=42;");
    fs::hard_link(f.0.join("settings.json"), f.0.join("alias.json")).unwrap();
    let output = f.run(r#"
      import assert from 'node:assert/strict';
      const publicPath = './public.mjs';
      assert.equal((await import(publicPath)).value,42);
      for (const path of ['./settings.json?dynamic=1','./%73ettings.json','./alias.json','./allow.mjs']) {
        await assert.rejects(import(path));
      }
      console.log('DYNAMIC_PRIVATE_OK');
      //# sourceURL=holo-plugins:///allow/allow.mjs
    "#, "settings.json");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"DYNAMIC_PRIVATE_OK\n");
}

#[test]
fn commonjs_json_require_uses_the_same_private_identity_boundary() {
    let f = Fixture::new();
    f.config(json!([]));
    f.write("host.json", "{\"public\":true}");
    let positive = f.run_name("require('node:assert/strict').equal(require('./host.json').public,true); console.log('CJS_PUBLIC_OK');", "settings.json", "entry.cjs");
    assert!(
        positive.status.success(),
        "{}",
        String::from_utf8_lossy(&positive.stderr)
    );
    assert_eq!(positive.stdout, b"CJS_PUBLIC_OK\n");
    fs::hard_link(f.0.join("settings.json"), f.0.join("alias.json")).unwrap();
    let negative = f.run_name(
        "console.log(require('./alias.json').context.host.marker);",
        "settings.json",
        "entry.cjs",
    );
    assert!(!negative.status.success());
    assert!(negative.stdout.is_empty());
}

#[test]
fn live_guest_import_rejects_rebound_config_namespace_and_external_current_hardlink() {
    use std::io::{BufRead, BufReader, Read};
    use std::process::Stdio;
    for external in [false, true] {
        let f = Fixture::new();
        let outside = Fixture::new();
        let config_root = if external { &outside.0 } else { &f.0 };
        fs::create_dir(config_root.join("private")).unwrap();
        fs::create_dir(f.0.join("data")).unwrap();
        f.write("data/signal", "wait");
        fs::write(
            config_root.join("allow.mjs"),
            "export default c => { c.holo.engineGate(()=>({action:'allow'})); };",
        )
        .unwrap();
        let config = json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2,
            "codeGeneration":{"strings":{"access":"none"},"wasm":{"access":"none"},"dynamicImport":{"access":"controlled","maxSourceBytes":65536,"maxOperations":16,"decisionTimeoutMs":1000}},
            "filesystem":{"access":"sandboxed","roots":[{"rootId":"signal","virtualUrl":"holo-fs://signal/","rights":["read"],"symlinks":"deny"}],"limits":{"maxReadBytes":4096,"maxWriteBytes":4096,"maxOpenHandles":4,"maxWatchers":0,"maxDirectoryEntries":8,"maxQueuedEvents":0}}},
            "filesystemRoots":[{"rootId":"signal","hostPath":f.0.join("data")}],
            "context":{"schemaVersion":1,"host":{"marker":"INITIAL_PRIVATE"}},
            "plugins":[{"id":"allow","use":"../allow.mjs"}]});
        let path = config_root.join("private/settings.json");
        fs::write(&path, config.to_string()).unwrap();
        f.write("entry.mjs",&format!(r#"
          import assert from 'node:assert/strict'; import fs from 'node:fs';
          console.log('READY');
          await new Promise(resolve=>{{const timer=setInterval(()=>{{if(fs.readFileSync('holo-fs://signal/signal','utf8')==='go'){{clearInterval(timer);resolve();}}}},10);}});
          const paths={};
          for(const path of paths) await assert.rejects(import(path));
          const publicPath='./public.json'; assert.equal((await import(publicPath)).default.public,true);
          console.log('NAMESPACE_PRIVATE_OK');
        "#,if external { r#"["./alias.json"]"# } else { r#"["./private/settings.json","./%70rivate/settings.json","./old/settings.json","./alias.json"]"# }));
        let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--timeout",
                "5000",
                "--host-config",
                path.to_str().unwrap(),
                "entry.mjs",
            ])
            .current_dir(&f.0)
            .env_clear()
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        stdout.read_line(&mut ready).unwrap();
        assert_eq!(ready, "READY\n");
        fs::rename(config_root.join("private"), config_root.join("old")).unwrap();
        fs::create_dir(config_root.join("private")).unwrap();
        fs::write(&path, "{\"marker\":\"CURRENT_B_PRIVATE\"}").unwrap();
        fs::hard_link(&path, f.0.join("alias.json")).unwrap();
        f.write("public.json", "{\"public\":true}");
        f.write("data/signal", "go");
        let mut output = String::new();
        stdout.read_to_string(&mut output).unwrap();
        let status = child.wait().unwrap();
        let mut errors = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut errors)
            .unwrap();
        assert!(status.success(), "external={external}: {output} {errors}");
        assert_eq!(output, "NAMESPACE_PRIVATE_OK\n");
    }
}
