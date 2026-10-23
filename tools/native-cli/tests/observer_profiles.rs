use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-native-observer-profile-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let private = root.join("private");
        fs::create_dir(&private).unwrap();
        fs::set_permissions(&private, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }

    fn run(&self, registration: Value, module: &str) -> std::process::Output {
        fs::write(self.0.join("profile.mjs"), module).unwrap();
        fs::write(
            self.0.join("entry.mjs"),
            "const marker = 'PRIVATE_GUEST_SOURCE'; setTimeout(() => console.log('GUEST_OK', marker.length), 200);",
        )
        .unwrap();
        let config = json!({
            "schemaVersion": 1,
            "sandboxPolicy": {
                "schemaVersion": 2,
                "diagnostics": {
                    "sourceReader": "none", "maxSourceReadBytes": 0,
                    "observerEvents": ["script.compiled"], "maxQueuedEvents": 32,
                    "maxObserverCallbackMs": 1000, "retentionMs": 0
                }
            },
            "observerProfiles": [{
                "id": "monitor", "use": "./profile.mjs", "config": {"label":"monitor"},
                "registration": registration,
                "sink": {"path": "./private/observer.jsonl", "maxBytes": 65536}
            }]
        });
        fs::write(self.0.join("host.json"), config.to_string()).unwrap();
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--timeout",
                "5000",
                "--host-config",
                "host.json",
                "entry.mjs",
            ])
            .current_dir(&self.0)
            .env_clear()
            .env("PATH", "")
            .output()
            .unwrap()
    }

    fn rows(&self) -> Vec<Value> {
        fs::read_to_string(self.0.join("private/observer.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn isolated_profile_publishes_source_free_guest_metadata() {
    let fixture = Fixture::new();
    let output = fixture.run(
        json!({
            "acceptHighCost": true, "events": ["script.compiled"],
            "maxQueuedEvents": 16, "callbackTimeoutMs": 100
        }),
        "export default (event, config, sink) => { if (event.event === 'script.compiled' && config.label === 'monitor') sink.publish() }",
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "stdout={stdout} stderr={stderr}");
    assert_eq!(stdout, "GUEST_OK 20\n");
    let rows = fixture.rows();
    assert!(rows.iter().any(|row| row["status"] == "callback.started"));
    assert!(rows.iter().any(|row| row["status"] == "event" && row["sourceEvent"]["event"] == "script.compiled"));
    assert!(
        rows.iter()
            .all(|row| row["profileId"] == "monitor" && row["schemaVersion"] == 1)
    );
    assert!(
        !serde_json::to_string(&rows)
            .unwrap()
            .contains("PRIVATE_GUEST_SOURCE")
    );
    assert_eq!(
        fs::metadata(fixture.0.join("private/observer.jsonl"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn denied_profile_registration_rejects_before_guest_entry() {
    let fixture = Fixture::new();
    let output = fixture.run(
        json!({"events": ["script.compiled"]}),
        "export default () => {}",
    );
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("GUEST_OK"));
    assert!(fixture.rows().is_empty());
}

#[test]
fn invalid_profile_module_rejects_before_guest_entry() {
    let fixture = Fixture::new();
    let output = fixture.run(
        json!({
            "acceptHighCost": true, "events": ["script.compiled"],
            "maxQueuedEvents": 16, "callbackTimeoutMs": 100
        }),
        "export default (",
    );
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("GUEST_OK"));
    assert!(fixture.rows().is_empty());
}

#[test]
fn one_profile_failure_does_not_stop_another_profile_or_guest() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("failed.mjs"),
        "export default () => { throw Error('private failure') }",
    )
    .unwrap();
    fs::write(
        fixture.0.join("healthy.mjs"),
        "export default (_event, _config, sink) => sink.publish()",
    )
    .unwrap();
    fs::write(
        fixture.0.join("entry.mjs"),
        "setTimeout(() => console.log('TWO_PROFILES_OK'), 200)",
    )
    .unwrap();
    let registration = json!({
        "acceptHighCost": true, "events": ["script.compiled"],
        "maxQueuedEvents": 16, "callbackTimeoutMs": 100
    });
    let config = json!({
        "schemaVersion": 1,
        "sandboxPolicy": {
            "schemaVersion": 2,
            "diagnostics": {
                "sourceReader": "none", "maxSourceReadBytes": 0,
                "observerEvents": ["script.compiled"], "maxQueuedEvents": 32,
                "maxObserverCallbackMs": 1000, "retentionMs": 0
            }
        },
        "observerProfiles": [
            {"id":"failed","use":"./failed.mjs","registration":registration,
             "sink":{"path":"./private/failed.jsonl","maxBytes":65536}},
            {"id":"healthy","use":"./healthy.mjs","registration":registration,
             "sink":{"path":"./private/healthy.jsonl","maxBytes":65536}}
        ]
    });
    fs::write(fixture.0.join("host.json"), config.to_string()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args([
            "--timeout",
            "5000",
            "--host-config",
            "host.json",
            "entry.mjs",
        ])
        .current_dir(&fixture.0)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "stdout={stdout} stderr={stderr}");
    assert_eq!(stdout, "TWO_PROFILES_OK\n");
    let failed = fs::read_to_string(fixture.0.join("private/failed.jsonl")).unwrap();
    let healthy = fs::read_to_string(fixture.0.join("private/healthy.jsonl")).unwrap();
    assert!(
        failed.lines().any(
            |line| serde_json::from_str::<Value>(line).unwrap()["status"] == "callback.failed"
        )
    );
    assert!(
        healthy
            .lines()
            .any(|line| serde_json::from_str::<Value>(line).unwrap()["status"] == "event")
    );
    assert!(!stderr.contains("private failure"));
}

#[test]
fn profile_dependency_is_host_labeled_before_guest_planner_reads_a_hardlink_alias() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("profile.mjs"),
        "import './dependency.mjs'; export default () => {}",
    )
    .unwrap();
    fs::write(
        fixture.0.join("dependency.mjs"),
        "export const privateValue = 1",
    )
    .unwrap();
    fs::hard_link(
        fixture.0.join("dependency.mjs"),
        fixture.0.join("dependency-alias.mjs"),
    )
    .unwrap();
    fs::write(
        fixture.0.join("entry.mjs"),
        "import './dependency-alias.mjs'; console.log('GUEST_MUST_NOT_RUN')",
    )
    .unwrap();
    let config = json!({
        "schemaVersion": 1,
        "sandboxPolicy": {
            "schemaVersion": 2,
            "diagnostics": {
                "sourceReader": "none", "maxSourceReadBytes": 0,
                "observerEvents": ["runtime.terminated"], "maxQueuedEvents": 16,
                "maxObserverCallbackMs": 1000, "retentionMs": 0
            }
        },
        "observerProfiles": [{
            "id": "monitor", "use": "./profile.mjs",
            "registration": {"events": ["runtime.terminated"], "callbackTimeoutMs": 100},
            "sink": {"path": "./private/observer.jsonl", "maxBytes": 65536}
        }]
    });
    fs::write(fixture.0.join("host.json"), config.to_string()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args([
            "--timeout",
            "5000",
            "--host-config",
            "host.json",
            "entry.mjs",
        ])
        .current_dir(&fixture.0)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("GUEST_MUST_NOT_RUN"));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("ERR_HOLONOMY_MODULE_HOST_READ_FAILED"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
