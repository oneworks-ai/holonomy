use holonomy_desktop_host::{HostConfiguration, RuntimeLaunch, SourceAdmission, SourceStore};
use serde_json::json;
use std::{
    fs,
    io::Cursor,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);

#[test]
fn source_snapshot_allowlist_is_exact_without_changing_standalone_query_identity() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("module-例 @.mjs"), "export default 42;").unwrap();
    let url = "app://workspace/module-%E4%BE%8B%20@.mjs";
    let mut standalone = SourceStore::new(&fixture.0.join("entry.mjs")).unwrap();
    assert!(standalone.read(url).unwrap().is_some());
    assert!(
        standalone
            .read(&format!("{url}?other=1"))
            .unwrap()
            .is_some()
    );
    assert!(
        standalone
            .read("app://workspace/%6dodule-%E4%BE%8B%20@.mjs")
            .is_err()
    );
    let mut snapshot = SourceStore::new(&fixture.0.join("entry.mjs")).unwrap();
    snapshot
        .restrict_to_urls(vec![snapshot.entry_url.clone(), url.into()])
        .unwrap();
    assert!(snapshot.read(url).unwrap().is_some());
    assert!(snapshot.read(&format!("{url}?other=1")).unwrap().is_none());
    assert!(snapshot.read(&format!("{url}#other")).unwrap().is_none());
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "holo-private-source-owner-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("entry.mjs"), "export default 1;").unwrap();
        fs::write(
            path.join("host.json"),
            json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2}}).to_string(),
        )
        .unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn guest_directory_probe_is_not_a_source_but_private_directories_still_deny() {
    let f = Fixture::new();
    fs::create_dir_all(f.0.join("ordinary")).unwrap();
    fs::write(f.0.join("ordinary/index.mjs"), "export default 42;").unwrap();
    fs::create_dir_all(f.0.join("private")).unwrap();
    let admission = SourceAdmission::default();
    let mut store = SourceStore::with_admission(&f.0.join("entry.mjs"), admission.clone()).unwrap();

    assert!(store.read("app://workspace/ordinary").unwrap().is_none());
    assert!(
        store
            .read_resource("app://workspace/ordinary")
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .read("app://workspace/ordinary/index.mjs")
            .unwrap()
            .is_some()
    );
    assert!(
        store
            .read_resource("app://workspace/ordinary/index.mjs")
            .unwrap()
            .is_some()
    );

    let private = f.0.join("private").canonicalize().unwrap();
    admission.reserve_private_directory(&private).unwrap();
    assert!(store.read("app://workspace/private").is_err());
    assert!(store.read_resource("app://workspace/private").is_err());
    fs::rename(&private, f.0.join("moved")).unwrap();
    assert!(store.read("app://workspace/moved").is_err());
    assert!(store.read_resource("app://workspace/moved").is_err());
}

#[test]
fn private_launch_rejects_config_identity_replacement() {
    let f = Fixture::new();
    let config = HostConfiguration::read(&f.0.join("host.json")).unwrap();
    let launch = RuntimeLaunch {
        workspace_root: None,
        module_allowlist: None,
        module_aliases: None,
        module_metadata_only: vec![],
        schema_version: 1,
        generation: 1,
        entry: f.0.join("entry.mjs"),
        argv: vec![],
        timeout: None,
        test_mode: false,
        host_config: Some(config),
        watch_config: None,
        service_plugin_config: None,
        process_profiles_manifest: None,
        service_plugin_revision: None,
        inspector_socket: None,
        inspector_wait_for_debugger: false,
    };
    let encoded = launch.encode().unwrap();
    fs::rename(f.0.join("host.json"), f.0.join("old.json")).unwrap();
    fs::write(f.0.join("host.json"), "{}").unwrap();
    assert!(RuntimeLaunch::read(Cursor::new(format!("{encoded}\n"))).is_err());
}

#[test]
fn private_slot_replacement_and_its_hardlink_are_denied_before_watch_poll() {
    let f = Fixture::new();
    let config = HostConfiguration::read(&f.0.join("host.json")).unwrap();
    let mut store = SourceStore::with_admission(
        &f.0.join("entry.mjs"),
        config.plugin_sources.admission.clone(),
    )
    .unwrap();
    fs::rename(f.0.join("host.json"), f.0.join("old.json")).unwrap();
    fs::write(f.0.join("host.json"), "{\"private\":true}").unwrap();
    fs::hard_link(f.0.join("host.json"), f.0.join("alias.json")).unwrap();
    assert!(store.read("app://workspace/alias.json").is_err());
    assert!(store.read("app://workspace/host.json?new=1").is_err());
    assert!(store.read("app://workspace/old.json").is_err());
    assert!(store.read("app://workspace/entry.mjs").unwrap().is_some());
}

#[test]
fn failed_candidate_keeps_previously_identified_files_private() {
    let f = Fixture::new();
    let config = HostConfiguration::read(&f.0.join("host.json")).unwrap();
    let admission = config.plugin_sources.admission.clone();
    let mut store = SourceStore::with_admission(&f.0.join("entry.mjs"), admission.clone()).unwrap();
    store.read("app://workspace/entry.mjs").unwrap();
    fs::write(f.0.join("candidate.mjs"), "export default () => {};").unwrap();
    fs::write(f.0.join("host.json"), json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"plugins":[{"id":"first","use":"./candidate.mjs"},{"id":"collision","use":"./entry.mjs"}]}).to_string()).unwrap();
    assert!(HostConfiguration::read_with_admission(&f.0.join("host.json"), admission).is_err());
    assert!(store.read("app://workspace/candidate.mjs").is_err());
    assert!(store.read("app://workspace/entry.mjs").unwrap().is_some());
}
