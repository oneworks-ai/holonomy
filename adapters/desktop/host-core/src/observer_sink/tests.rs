use super::*;
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::Instant,
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "holo-observer-sink-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn config(&self) -> ObserverSinkInstallation {
        ObserverSinkInstallation {
            path: self.0.join("observer.jsonl"),
            max_bytes: 1024 * 1024,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn event() -> Value {
    json!({"schemaVersion":1,"event":"script.compiled","generation":1,"observedAt":1,"sequence":1,
        "payload":{"scriptId":"native-script-1","sourceBytes":3,"sourceSha256":"a".repeat(64)}})
}
fn record(status: ObserverOutputStatus) -> ObserverOutputRecord {
    ObserverOutputRecord {
        epoch: 1,
        status,
        event: Some(event()),
        dropped: 0,
    }
}

fn wait_for_line(path: &std::path::Path) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(bytes) = fs::read(path)
            && bytes.last() == Some(&b'\n')
        {
            return serde_json::from_slice(&bytes).unwrap();
        }
        assert!(Instant::now() < deadline, "writer did not emit a line");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn source_free_records_are_async_bounded_and_locked() {
    let fixture = Fixture::new();
    let config = fixture.config();
    let admission = SourceAdmission::default();
    let sink = NativeObserverSink::open("monitor", &config, &admission).unwrap();
    assert_eq!(sink.session_id().len(), 32);
    assert!(NativeObserverSink::open("monitor", &config, &admission).is_err());
    let mut invalid = record(ObserverOutputStatus::Event);
    invalid.event.as_mut().unwrap()["payload"]["source"] = json!("private bytes");
    assert!(!sink.try_record(invalid));
    assert!(sink.try_record(record(ObserverOutputStatus::CallbackStarted)));
    let line = wait_for_line(&config.path);
    assert_eq!(line["status"], "callback.started");
    assert_eq!(line["profileId"], "monitor");
    assert_eq!(line["sourceEvent"], event());
    assert!(line.get("source").is_none());
    assert_eq!(fs::metadata(&config.path).unwrap().mode() & 0o777, 0o600);
    sink.close();
    assert!(!sink.try_record(record(ObserverOutputStatus::Event)));
}

#[test]
fn unsafe_history_permissions_links_and_rotation_fail_closed() {
    let fixture = Fixture::new();
    let config = fixture.config();
    fs::write(&config.path, "{}\n").unwrap();
    fs::set_permissions(&config.path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(NativeObserverSink::open("monitor", &config, &SourceAdmission::default()).is_err());
    assert_eq!(fs::read_to_string(&config.path).unwrap(), "{}\n");
    fs::write(&config.path, "").unwrap();
    fs::set_permissions(&config.path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(NativeObserverSink::open("monitor", &config, &SourceAdmission::default()).is_err());
    fs::set_permissions(&config.path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(&config.path, fixture.0.join("alias")).unwrap();
    assert!(NativeObserverSink::open("monitor", &config, &SourceAdmission::default()).is_err());
    fs::remove_file(fixture.0.join("alias")).unwrap();
    let sink = NativeObserverSink::open("monitor", &config, &SourceAdmission::default()).unwrap();
    fs::rename(&config.path, fixture.0.join("old")).unwrap();
    fs::write(&config.path, "").unwrap();
    fs::set_permissions(&config.path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(sink.try_record(record(ObserverOutputStatus::Event)));
    let deadline = Instant::now() + Duration::from_secs(5);
    while sink.available() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!sink.available());
    assert_eq!(fs::read(&config.path).unwrap(), b"");
}

#[test]
fn strict_history_rejects_null_source_event_and_unexpected_drop_fields() {
    let fixture = Fixture::new();
    let config = fixture.config();
    let base = json!({"schemaVersion":1,"sessionId":"a".repeat(32),"sequence":1,
        "generation":1,"profileId":"monitor","epoch":1,"observedAt":1,"status":"event",
        "sourceEvent":event()});
    for malformed in [
        {
            let mut value = base.clone();
            value["sourceEvent"] = Value::Null;
            value
        },
        {
            let mut value = base.clone();
            value["dropped"] = json!(0);
            value
        },
        {
            let mut value = base.clone();
            value["profileId"] = json!("other");
            value
        },
        {
            let mut value = base.clone();
            value["sourceEvent"]["payload"]["source"] = json!("secret");
            value
        },
    ] {
        let bytes = format!("{malformed}\n");
        fs::write(&config.path, &bytes).unwrap();
        fs::set_permissions(&config.path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(NativeObserverSink::open("monitor", &config, &SourceAdmission::default()).is_err());
        assert_eq!(fs::read_to_string(&config.path).unwrap(), bytes);
    }
}

#[test]
fn private_parent_requires_0700_and_rejects_symlink_ancestor_and_rebind() {
    let fixture = Fixture::new();
    let parent = fixture.0.join("private");
    fs::create_dir(&parent).unwrap();
    let config = ObserverSinkInstallation {
        path: parent.join("observer.jsonl"),
        max_bytes: 1024 * 1024,
    };
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o750)).unwrap();
    assert!(NativeObserverSink::open("monitor", &config, &SourceAdmission::default()).is_err());
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
    std::os::unix::fs::symlink(&parent, fixture.0.join("alias")).unwrap();
    let alias = ObserverSinkInstallation {
        path: fixture.0.join("alias/observer.jsonl"),
        max_bytes: config.max_bytes,
    };
    assert!(NativeObserverSink::open("monitor", &alias, &SourceAdmission::default()).is_err());
    let sink = NativeObserverSink::open("monitor", &config, &SourceAdmission::default()).unwrap();
    fs::rename(&parent, fixture.0.join("moved")).unwrap();
    fs::create_dir(&parent).unwrap();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(sink.try_record(record(ObserverOutputStatus::Event)));
    let deadline = Instant::now() + Duration::from_secs(5);
    while sink.available() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!sink.available());
    assert!(!config.path.exists());
}

#[test]
fn byte_cap_disables_writer_without_blocking_try_record() {
    let fixture = Fixture::new();
    let mut config = fixture.config();
    config.max_bytes = 1024;
    let sink = NativeObserverSink::open("monitor", &config, &SourceAdmission::default()).unwrap();
    let start = Instant::now();
    for _ in 0..1000 {
        let _ = sink.try_record(record(ObserverOutputStatus::Event));
    }
    assert!(start.elapsed() < Duration::from_secs(2));
    let deadline = Instant::now() + Duration::from_secs(5);
    while sink.available() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!sink.available());
    assert!(fs::metadata(&config.path).unwrap().len() <= config.max_bytes);
}
