use holonomy_desktop_host::{HostConfiguration, PluginConfigWatch, RuntimeLaunch, SourceStore};
use serde_json::json;
use std::{
    fs,
    io::Cursor,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-observer-profile-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("monitor.mjs"), "export default () => {};").unwrap();
        Self(root)
    }
    fn write(&self, value: &serde_json::Value) -> PathBuf {
        let path = self.0.join("host.json");
        fs::write(&path, value.to_string()).unwrap();
        path
    }
    fn host(&self) -> serde_json::Value {
        json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"observerProfiles":[{
            "id":"monitor","use":"./monitor.mjs","registration":{"events":["script.compiled"],"maxQueuedEvents":16,"callbackTimeoutMs":100,"acceptHighCost":true},
            "sink":{"path":"./observer.jsonl","maxBytes":1048576}
        }]})
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn profile_preparation_is_private_and_does_not_install_ordinary_plugin() {
    let fixture = Fixture::new();
    let host = fixture.write(&fixture.host());
    let mut config = HostConfiguration::read(&host).unwrap();
    assert!(config.runtime_plugins.is_empty());
    assert_eq!(config.runtime_observer_profiles.len(), 1);
    let profile = &config.runtime_observer_profiles[0];
    assert_eq!(profile.id, "monitor");
    assert_eq!(profile.module.instance_id, "observer.monitor");
    assert_eq!(profile.module.export_name, "default");
    assert_eq!(
        profile.sink.path,
        fixture.0.canonicalize().unwrap().join("observer.jsonl")
    );
    let entry_url = profile.module.entry_url.clone();
    assert!(config.observer_sources.read(&entry_url).unwrap().is_some());
    config.prepare_observer_sinks().unwrap();
    assert!(config.observer_sinks.contains_key("monitor"));
    let mut guest = SourceStore::with_admission(
        &fixture.0.join("monitor.mjs"),
        config.plugin_sources.admission.clone(),
    )
    .unwrap();
    assert!(guest.read(&guest.entry_url.clone()).is_err());
    let mut sink_guest = SourceStore::with_admission(
        &fixture.0.join("observer.jsonl"),
        config.plugin_sources.admission.clone(),
    )
    .unwrap();
    assert!(sink_guest.read(&sink_guest.entry_url.clone()).is_err());
    let encoded = json!({"schemaVersion":1,"generation":1,"entry":fixture.0.join("monitor.mjs"),"argv":[],"timeout":1000,"testMode":true,"hostConfig":config});
    let mut restored = RuntimeLaunch::read(Cursor::new(format!("{encoded}\n"))).unwrap();
    let selected = restored.host_config.as_mut().unwrap();
    assert!(
        selected
            .observer_sources
            .read(&entry_url)
            .unwrap()
            .is_some()
    );
}

#[test]
fn invalid_ids_collisions_config_size_and_private_compiled_fields_fail() {
    let fixture = Fixture::new();
    for id in ["", "-bad", "a".repeat(65).as_str(), "bad/slash"] {
        let mut value = fixture.host();
        value["observerProfiles"][0]["id"] = json!(id);
        assert!(
            HostConfiguration::read(&fixture.write(&value)).is_err(),
            "accepted {id}"
        );
    }
    let mut value = fixture.host();
    value["plugins"] = json!([{"id":"observer.monitor","use":"./monitor.mjs"}]);
    assert!(HostConfiguration::read(&fixture.write(&value)).is_err());
    value = fixture.host();
    value["observerProfiles"][0]["config"] = json!({"large":"x".repeat(65536)});
    assert!(HostConfiguration::read(&fixture.write(&value)).is_err());
    value = fixture.host();
    value["observerProfiles"][0]["sink"]["maxBytes"] = json!(1023);
    assert!(HostConfiguration::read(&fixture.write(&value)).is_err());
    value = fixture.host();
    value["observerProfiles"][0]["sink"]["path"] = json!(fixture.0.join("observer.jsonl"));
    assert!(HostConfiguration::read(&fixture.write(&value)).is_err());
    for key in ["runtimeObserverProfiles", "runtimeObserverRoots"] {
        value = fixture.host();
        value[key] = json!([]);
        assert!(
            HostConfiguration::read(&fixture.write(&value)).is_err(),
            "accepted {key}"
        );
    }
}

#[test]
fn diagnostic_source_limits_apply_before_copy_and_on_cache_hits() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("monitor.mjs"), vec![b'x'; 5000]).unwrap();
    let mut config = HostConfiguration::read(&fixture.write(&fixture.host())).unwrap();
    let url = config.runtime_observer_profiles[0].module.entry_url.clone();
    assert!(config.observer_sources.read_with_limit(&url, 1000).is_err());
    assert!(
        config
            .observer_sources
            .read_with_limit(&url, 5000)
            .unwrap()
            .is_some()
    );
    assert!(config.observer_sources.read_with_limit(&url, 1000).is_err());
    fs::write(fixture.0.join("large.mjs"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
    let root_url = config.runtime_observer_profiles[0].module.root_url.clone();
    assert!(
        config
            .observer_sources
            .read(&format!("{root_url}large.mjs"))
            .is_err()
    );
    assert!(
        config
            .observer_sources
            .read_with_limit(&format!("{root_url}large.mjs"), 8 * 1024 * 1024)
            .is_err()
    );
}

#[test]
fn diagnostic_source_graph_caps_bytes_and_module_count() {
    let fixture = Fixture::new();
    let mut config = HostConfiguration::read(&fixture.write(&fixture.host())).unwrap();
    let root_url = config.runtime_observer_profiles[0].module.root_url.clone();
    for index in 0..4 {
        let name = format!("large-{index}.mjs");
        fs::write(fixture.0.join(&name), vec![b'x'; 1024 * 1024]).unwrap();
        assert!(
            config
                .observer_sources
                .read(&format!("{root_url}{name}"))
                .unwrap()
                .is_some()
        );
    }
    fs::write(fixture.0.join("one-more.mjs"), "x").unwrap();
    assert!(
        config
            .observer_sources
            .read(&format!("{root_url}one-more.mjs"))
            .is_err()
    );

    let mut fresh = HostConfiguration::read(&fixture.write(&fixture.host())).unwrap();
    for index in 0..128 {
        let name = format!("small-{index}.mjs");
        fs::write(fixture.0.join(&name), "x").unwrap();
        assert!(
            fresh
                .observer_sources
                .read(&format!("{root_url}{name}"))
                .unwrap()
                .is_some()
        );
    }
    fs::write(fixture.0.join("small-128.mjs"), "x").unwrap();
    assert!(
        fresh
            .observer_sources
            .read(&format!("{root_url}small-128.mjs"))
            .is_err()
    );
}

#[test]
fn private_launch_rejects_changed_compiled_profile_identity() {
    let fixture = Fixture::new();
    let config = HostConfiguration::read(&fixture.write(&fixture.host())).unwrap();
    let original = json!({"schemaVersion":1,"generation":1,"entry":fixture.0.join("monitor.mjs"),
        "argv":[],"timeout":1000,"testMode":true,"hostConfig":config});
    assert!(RuntimeLaunch::read(Cursor::new(format!("{original}\n"))).is_ok());
    for (pointer, replacement) in [
        (
            "/hostConfig/runtimeObserverProfiles/0/module/instanceId",
            json!("other"),
        ),
        (
            "/hostConfig/runtimeObserverProfiles/0/registration/events",
            json!(["runtime.terminated"]),
        ),
        (
            "/hostConfig/runtimeObserverProfiles/0/sink/maxBytes",
            json!(2048),
        ),
        (
            "/hostConfig/runtimeObserverRoots/0/instanceId",
            json!("other"),
        ),
    ] {
        let mut changed = original.clone();
        *changed.pointer_mut(pointer).unwrap() = replacement;
        assert!(
            RuntimeLaunch::read(Cursor::new(format!("{changed}\n"))).is_err(),
            "accepted {pointer}"
        );
    }
    let mut missing = original;
    missing["hostConfig"]
        .as_object_mut()
        .unwrap()
        .remove("runtimeObserverProfiles");
    assert!(RuntimeLaunch::read(Cursor::new(format!("{missing}\n"))).is_err());
}

#[test]
fn ordinary_plugin_watch_rejects_profile_change() {
    let fixture = Fixture::new();
    let original = fixture.host();
    let path = fixture.write(&original);
    let initial = HostConfiguration::read(&path).unwrap();
    let mut watch = PluginConfigWatch::new(path.clone(), &initial);
    let start = Instant::now();
    assert!(watch.poll(start).unwrap().is_none());
    let mut changed = original;
    changed["observerProfiles"][0]["registration"]["callbackTimeoutMs"] = json!(200);
    fixture.write(&changed);
    assert_eq!(
        watch.poll(start + Duration::from_secs(1)).unwrap_err(),
        "non-plugin configuration changed; restart required"
    );
}
