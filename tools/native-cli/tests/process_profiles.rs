#![cfg(target_os = "macos")]

use serde_json::json;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-process-install-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        fs::write(
            root.join("host.json"),
            json!({
                "schemaVersion":1,
                "sandboxPolicy":{"schemaVersion":2},
                "processProfileId":"developer"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            root.join("process-profiles.json"),
            json!({
                "schemaVersion":1,
                "profiles":{"developer":{"profile":"process-profile-v1","executables":[]}}
            })
            .to_string(),
        )
        .unwrap();
        fs::set_permissions(
            root.join("process-profiles.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        fs::write(root.join("entry.js"), "console.log('PROFILE_ENTRY_OK')").unwrap();
        Self(root)
    }

    fn run(&self, entry: &str, manifest: &str) -> Output {
        self.run_with_backend(entry, manifest, None, false)
    }

    fn run_with_backend(
        &self,
        entry: &str,
        manifest: &str,
        backend: Option<&str>,
        experimental: bool,
    ) -> Output {
        let mut args = vec![
            "--timeout",
            "3000",
            "--host-config",
            "host.json",
            "--process-profiles",
            manifest,
        ];
        if let Some(path) = backend {
            args.extend(["--process-backends", path]);
        }
        if experimental {
            args.push("--experimental-v86-process");
        }
        args.push(entry);
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args(args)
            .current_dir(&self.0)
            .env_clear()
            .env("PATH", "")
            .output()
            .unwrap()
    }
}

#[test]
fn v86_backend_manifest_is_selected_privately_and_required_before_entry() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("assets")).unwrap();
    fs::write(
        fixture.0.join("process-profiles.json"),
        json!({
            "schemaVersion":1,
            "profiles":{"developer":{"profile":"process-profile-v1","backend":{"backendId":"experimental.v86-v1"}}}
        }).to_string(),
    ).unwrap();
    fs::write(
        fixture.0.join("process-backends.json"),
        json!({
            "schemaVersion":1,
            "backends":{"experimental.v86-v1":{"implementation":"builtin.v86-v1","artifactRoot":fixture.0.join("assets")}}
        }).to_string(),
    ).unwrap();
    fs::set_permissions(
        fixture.0.join("process-backends.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();

    assert!(
        !fixture
            .run("entry.js", "process-profiles.json")
            .status
            .success()
    );
    let output = fixture.run_with_backend(
        "entry.js",
        "process-profiles.json",
        Some("process-backends.json"),
        false,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"PROFILE_ENTRY_OK\n");
    let experimental = fixture.run_with_backend(
        "entry.js",
        "process-profiles.json",
        Some("process-backends.json"),
        true,
    );
    assert!(
        experimental.status.success(),
        "{}",
        String::from_utf8_lossy(&experimental.stderr)
    );
    fs::write(
        fixture.0.join("entry.js"),
        "require('./process-backends.json'); console.log('LEAK')",
    )
    .unwrap();
    let blocked = fixture.run_with_backend(
        "entry.js",
        "process-profiles.json",
        Some("process-backends.json"),
        false,
    );
    assert!(!blocked.status.success());
    assert!(blocked.stdout.is_empty());
    assert!(
        !fixture
            .run_with_backend("entry.js", "process-profiles.json", None, true)
            .status
            .success()
    );
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn owner_private_process_profile_is_installed_before_guest_entry() {
    let fixture = Fixture::new();
    let output = fixture.run("entry.js", "process-profiles.json");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"PROFILE_ENTRY_OK\n");
}

#[test]
fn process_profile_manifest_is_not_guest_source() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("entry.js"),
        "require('./process-profiles.json'); console.log('LEAK')",
    )
    .unwrap();
    let output = fixture.run("entry.js", "process-profiles.json");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn unsafe_process_manifest_fails_before_entry() {
    let fixture = Fixture::new();
    let manifest = fixture.0.join("process-profiles.json");
    let link = fixture.0.join("linked.json");
    symlink(&manifest, &link).unwrap();
    assert!(!fixture.run("entry.js", "linked.json").status.success());
    fs::set_permissions(&manifest, fs::Permissions::from_mode(0o644)).unwrap();
    let output = fixture.run("entry.js", "process-profiles.json");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
