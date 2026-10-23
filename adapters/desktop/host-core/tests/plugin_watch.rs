use holonomy_desktop_host::{HostConfiguration, PluginConfigWatch};
use serde_json::json;
use std::{
    fs,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[test]
fn config_watch_preserves_authority_and_reconciles_only_changed_plugins() {
    let root = std::env::temp_dir().join(format!(
        "holo-config-watch-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let path = root.join("host.json");
    fs::write(root.join("plugin.mjs"), "export default () => {};").unwrap();
    let base = json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"plugins":[]});
    fs::write(&path, base.to_string()).unwrap();
    let initial = HostConfiguration::read(&path).unwrap();
    let mut watch = PluginConfigWatch::new(path.clone(), &initial);
    let start = Instant::now();
    assert!(watch.poll(start).unwrap().is_none());

    let mut changed = base.clone();
    changed["plugins"] = json!([{"id":"first","use":"./plugin.mjs","config":{"value":1}}]);
    fs::write(&path, changed.to_string()).unwrap();
    let candidate = watch.poll(start + Duration::from_secs(1)).unwrap().unwrap();
    assert_eq!(candidate.runtime_plugins.len(), 1);
    watch.commit(PluginConfigWatch::plugins(&candidate));
    assert!(
        watch
            .poll(start + Duration::from_secs(2))
            .unwrap()
            .is_none()
    );

    fs::write(&path, "{\"plugins\":[").unwrap();
    assert!(watch.poll(start + Duration::from_secs(3)).is_err());
    assert!(
        watch
            .poll(start + Duration::from_secs(4))
            .unwrap()
            .is_none()
    );
    let mut escalation = changed.clone();
    escalation["context"] = json!({"schemaVersion":1,"guest":{"changed":true}});
    fs::write(&path, escalation.to_string()).unwrap();
    assert_eq!(
        watch.poll(start + Duration::from_secs(5)).unwrap_err(),
        "non-plugin configuration changed; restart required"
    );

    fs::write(&path, changed.to_string()).unwrap();
    assert!(
        watch
            .poll(start + Duration::from_secs(6))
            .unwrap()
            .is_none()
    );
    fs::write(&path, base.to_string()).unwrap();
    let removed = watch.poll(start + Duration::from_secs(7)).unwrap().unwrap();
    assert!(removed.runtime_plugins.is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn config_watch_retains_selected_private_process_profile() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!(
        "holo-process-watch-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    fs::write(root.join("plugin.mjs"), "export default () => {};").unwrap();
    let path = root.join("host.json");
    let manifest = root.join("process-profiles.json");
    let base = json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"processProfileId":"developer","plugins":[]});
    fs::write(&path, base.to_string()).unwrap();
    fs::write(&manifest, json!({"schemaVersion":1,"profiles":{"developer":{"profile":"process-profile-v1","backend":{"backendId":"native.darwin-seatbelt-v1"}}}}).to_string()).unwrap();
    fs::set_permissions(&manifest, fs::Permissions::from_mode(0o600)).unwrap();
    let mut initial = HostConfiguration::read(&path).unwrap();
    initial.install_process_profile(&manifest).unwrap();
    let mut watch = PluginConfigWatch::new(path.clone(), &initial);
    let start = Instant::now();
    assert!(watch.poll(start).unwrap().is_none());
    let mut changed = base.clone();
    changed["plugins"] = json!([{"id":"first","use":"./plugin.mjs"}]);
    fs::write(&path, changed.to_string()).unwrap();
    // The private manifest is not reread while a graph change is staged.
    fs::remove_file(&manifest).unwrap();
    let candidate = watch.poll(start + Duration::from_secs(1)).unwrap().unwrap();
    assert_eq!(candidate.process_profile, initial.process_profile);
    let mut changed_id = changed;
    changed_id["processProfileId"] = json!("other");
    fs::write(&path, changed_id.to_string()).unwrap();
    assert_eq!(
        watch.poll(start + Duration::from_secs(2)).unwrap_err(),
        "non-plugin configuration changed; restart required"
    );
    fs::remove_dir_all(root).unwrap();
}
