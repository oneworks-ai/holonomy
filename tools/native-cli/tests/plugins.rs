use serde_json::json;
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "holo-native-plugin-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        fs::create_dir(directory.join("plugins")).unwrap();
        Self(directory)
    }

    fn run(&self, config: serde_json::Value, entry: &str) -> Output {
        fs::write(self.0.join("host.json"), config.to_string()).unwrap();
        fs::write(self.0.join("entry.mjs"), entry).unwrap();
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--timeout",
                "5000",
                "--host-config",
                "host.json",
                "entry.mjs",
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .current_dir(&self.0)
            .output()
            .unwrap()
    }

    fn config(&self, plugins: serde_json::Value) -> serde_json::Value {
        json!({
            "schemaVersion": 1,
            "sandboxPolicy": {
                "schemaVersion": 2,
                "systemInformation": {
                    "defaultMode": "unavailable",
                    "fields": { "os.arch": { "allowedModes": ["synthetic"], "maxPrecision": "exact" } }
                }
            },
            "systemProjection": {
                "schemaVersion": 1,
                "fields": { "os.arch": { "mode": "synthetic", "precision": "exact", "value": "arm64" } }
            },
            "plugins": plugins
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn output_text(output: &Output) -> (String, String) {
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn initial_host_plugin_uses_real_cordis_scope_to_deny_guest_capability() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("plugins/deny.mjs"),
        "export default context => { context.holo.intercept({operation:'system.os.arch.read'}, invocation => context.holo.deny(invocation), {execution:'sync'}); };",
    )
    .unwrap();
    let output = fixture.run(
        fixture.config(json!([{"id":"deny-arch","use":"./plugins/deny.mjs"}])),
        "import assert from 'node:assert/strict'; import os from 'node:os'; assert.throws(()=>os.arch(),{code:'ERR_ACCESS_DENIED'}); console.log('PLUGIN_DENY_OK');",
    );
    let (stdout, stderr) = output_text(&output);
    assert!(output.status.success(), "stdout={stdout} stderr={stderr}");
    assert_eq!(stdout, "PLUGIN_DENY_OK\n");
}

#[test]
fn rejected_initial_plugin_prevents_all_guest_side_effects() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("plugins/broken.mjs"), "export default (").unwrap();
    let output = fixture.run(
        fixture.config(json!([{"id":"broken","use":"./plugins/broken.mjs"}])),
        "console.log('GUEST_MUST_NOT_RUN');",
    );
    let (stdout, _stderr) = output_text(&output);
    assert!(!output.status.success());
    assert!(!stdout.contains("GUEST_MUST_NOT_RUN"));
}

#[test]
fn plugin_dynamic_import_uses_native_parent_identity_not_a_forged_source_url() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("plugins/other.mjs"),
        "export default () => { globalThis.otherPluginEntry=import.meta.url; };",
    )
    .unwrap();
    fs::write(
        fixture.0.join("plugins/flag.mjs"),
        "export const checked=true;",
    )
    .unwrap();
    fs::write(
        fixture.0.join("plugins/check.mjs"),
        r#"
      export default async () => {
        const own=await import('./flag.mjs');
        if(own.checked!==true) throw new Error('own graph import failed');
        let rejected=false;
        try { await import(globalThis.otherPluginEntry); } catch { rejected=true; }
        if(!rejected) throw new Error('foreign graph imported');
      }
      //# sourceURL=holonomy:///runtime/native-control.js
    "#,
    )
    .unwrap();
    let output = fixture.run(
        fixture.config(json!([
            {"id":"other","use":"./plugins/other.mjs"},
            {"id":"check","use":"./plugins/check.mjs"}
        ])),
        "console.log('PLUGIN_GRAPH_BOUNDARY_OK');",
    );
    let (stdout, stderr) = output_text(&output);
    assert!(output.status.success(), "stdout={stdout} stderr={stderr}");
    assert_eq!(stdout, "PLUGIN_GRAPH_BOUNDARY_OK\n");
}

#[test]
fn initial_host_plugin_rejection_does_not_expose_the_host_error_value() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("plugins/private.mjs"),
        "export default async () => { throw new Error('HOST_PRIVATE_DETAIL_MUST_NOT_LEAK'); };",
    )
    .unwrap();
    let output = fixture.run(
        fixture.config(json!([{"id":"private","use":"./plugins/private.mjs"}])),
        "console.log('MUST_NOT_RUN');",
    );
    let (stdout, stderr) = output_text(&output);
    assert!(!output.status.success());
    assert!(stdout.is_empty());
    assert!(!stderr.contains("HOST_PRIVATE_DETAIL_MUST_NOT_LEAK"));
    assert!(stderr.contains("Host Runtime initialization failed"));
}

#[test]
fn manifest_config_schema_validates_before_guest_entry_and_preserves_node_defaults() {
    let fixture = Fixture::new();
    let package = fixture.0.join("plugins/schema-plugin");
    fs::create_dir(&package).unwrap();
    fs::write(
        package.join("package.json"),
        r#"{"holo":{"kind":"runtime-plugin","apiVersion":1,"entry":"./index.mjs","configSchema":"./schema.json"}}"#,
    )
    .unwrap();
    fs::write(
        package.join("schema.json"),
        r#"{"type":"object","additionalProperties":false,"properties":{"label":{"type":"string"},"optional":{"type":"string","default":"node-does-not-inject"}},"required":["label"]}"#,
    )
    .unwrap();
    fs::write(
        package.join("index.mjs"),
        "export default (context, config) => { if (config.optional !== undefined) throw new Error('schema default was injected'); if (config.label !== 'accepted') throw new Error('schema config missing'); context.holo.intercept({operation:'system.os.arch.read'}, invocation => context.holo.deny(invocation), {execution:'sync'}); };",
    )
    .unwrap();
    let valid = fixture.run(
        fixture.config(json!([{"id":"schema","use":"./plugins/schema-plugin","config":{"label":"accepted"}}])),
        "import assert from 'node:assert/strict'; import os from 'node:os'; assert.throws(()=>os.arch(),{code:'ERR_ACCESS_DENIED'}); console.log('PLUGIN_SCHEMA_OK');",
    );
    let (stdout, stderr) = output_text(&valid);
    assert!(valid.status.success(), "stdout={stdout} stderr={stderr}");
    assert_eq!(stdout, "PLUGIN_SCHEMA_OK\n");

    let invalid = fixture.run(
        fixture.config(json!([{"id":"schema","use":"./plugins/schema-plugin","config":{"label":1,"unknown":true}}])),
        "console.log('GUEST_MUST_NOT_RUN');",
    );
    let (stdout, _) = output_text(&invalid);
    assert!(!invalid.status.success());
    assert!(!stdout.contains("GUEST_MUST_NOT_RUN"));
}

#[test]
fn native_schema_validator_matches_shared_ajv_differential_vectors() {
    let fixture = Fixture::new();
    let package = fixture.0.join("plugins/schema-vectors");
    fs::create_dir(&package).unwrap();
    fs::write(
        package.join("package.json"),
        r#"{"holo":{"kind":"runtime-plugin","apiVersion":1,"entry":"./index.mjs","configSchema":"./schema.json"}}"#,
    )
    .unwrap();
    fs::write(package.join("index.mjs"), "export default () => {};").unwrap();
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/plugin-schema-vectors.json")).unwrap();
    for vector in vectors.as_array().unwrap() {
        fs::write(package.join("schema.json"), vector["schema"].to_string()).unwrap();
        let output = fixture.run(
            fixture.config(json!([{
                "id":"schema-vectors",
                "use":"./plugins/schema-vectors",
                "config":vector["config"]
            }])),
            "console.log('VECTOR_GUEST_RAN');",
        );
        let (stdout, stderr) = output_text(&output);
        let accepted = vector["accepted"] == true;
        assert_eq!(
            output.status.success(),
            accepted,
            "vector={} stdout={stdout} stderr={stderr}",
            vector["name"]
        );
        if !accepted {
            assert!(!stdout.contains("VECTOR_GUEST_RAN"));
            assert!(!stderr.contains("schema-vectors"));
            assert!(!stderr.contains("schema.json"));
        }
    }
}

#[test]
fn native_schema_validator_terminates_pathological_regex_before_guest_entry() {
    let fixture = Fixture::new();
    let package = fixture.0.join("plugins/regex-schema");
    fs::create_dir(&package).unwrap();
    fs::write(
        package.join("package.json"),
        r#"{"holo":{"kind":"runtime-plugin","apiVersion":1,"entry":"./index.mjs","configSchema":"./schema.json"}}"#,
    )
    .unwrap();
    fs::write(package.join("index.mjs"), "export default () => {};").unwrap();
    fs::write(
        package.join("schema.json"),
        r#"{"type":"string","pattern":"^(a+)+$"}"#,
    )
    .unwrap();
    let input = format!("{}!", "a".repeat(32_768));
    let output = fixture.run(
        fixture
            .config(json!([{"id":"regex-schema","use":"./plugins/regex-schema","config":input}])),
        "console.log('GUEST_MUST_NOT_RUN');",
    );
    let (stdout, stderr) = output_text(&output);
    assert!(!output.status.success(), "stdout={stdout} stderr={stderr}");
    assert!(!stdout.contains("GUEST_MUST_NOT_RUN"));
    // The CLI's 5 s launch timeout cannot substitute for Schema rejection.
    // This exact terminal also excludes a Guest entry or a generic CLI timeout.
    assert_eq!(
        stderr,
        "holo: Native plugin config Schema validation failed\n"
    );
    assert!(!stderr.contains("regex-schema"));
    assert!(!stderr.contains("^(a+)+$"));
}

#[test]
fn private_schema_helper_watchdog_terminates_pathological_regex() {
    // Exercise the helper's own 750 ms watchdog without CLI startup, Runtime
    // supervision or the parent's independent transport deadline. The 5 s
    // limit below is only an external test safety bound; expiry fails the test.
    let input = json!([{
        "schema": {"type": "string", "pattern": "^(a+)+$"},
        // Keep the private wire below a pipe buffer so the test writer cannot
        // block if the helper stops reading; this is still catastrophic input.
        "config": format!("{}!", "a".repeat(256)),
    }])
    .to_string();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut helper = Command::new(env!("CARGO_BIN_EXE_holo"))
        .arg("__plugin_validator_v1")
        .env_clear()
        .current_dir("/")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    helper
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    while helper.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = helper.kill();
            let _ = helper.wait();
            panic!("private Schema helper exceeded the external test deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = helper.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(2), "output={output:?}");
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}
