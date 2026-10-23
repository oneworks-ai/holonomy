use holonomy_desktop_host::HostConfiguration;
use serde_json::json;
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

fn root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "holo-host-plugin-schema-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn host_config(plugin: serde_json::Value) -> serde_json::Value {
    json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"plugins":[plugin]})
}

#[test]
fn manifest_schema_is_snapshotted_through_the_confined_plugin_root() {
    let root = root();
    let package = root.join("plugin");
    fs::create_dir_all(&package).unwrap();
    fs::write(package.join("index.mjs"), "export default () => {};").unwrap();
    fs::write(package.join("schema.json"), r#"{"type":"object"}"#).unwrap();
    fs::write(
        package.join("package.json"),
        r#"{"holo":{"kind":"runtime-plugin","apiVersion":1,"entry":"./index.mjs","configSchema":"./schema.json"}}"#,
    )
    .unwrap();
    let path = root.join("host.json");
    fs::write(
        &path,
        host_config(json!({"id":"schema","use":"./plugin","config":{}})).to_string(),
    )
    .unwrap();
    let configuration = HostConfiguration::read(&path).unwrap();
    assert_eq!(configuration.runtime_plugins.len(), 1);
    assert_eq!(
        configuration.runtime_plugins[0].config_schema,
        Some(json!({"type":"object"}))
    );

    fs::remove_file(package.join("schema.json")).unwrap();
    std::os::unix::fs::symlink(root.join("outside.json"), package.join("schema.json")).unwrap();
    fs::write(root.join("outside.json"), r#"{"type":"object"}"#).unwrap();
    assert!(HostConfiguration::read(&path).is_err());
    fs::remove_file(package.join("schema.json")).unwrap();
    fs::write(package.join("schema.json"), vec![b' '; 1024 * 1024 + 1]).unwrap();
    assert!(HostConfiguration::read(&path).is_err());
    fs::remove_dir_all(root).unwrap();
}
