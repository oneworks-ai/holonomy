use super::*;
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "holo-audit-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn config(&self) -> DiagnosticAuditInstallation {
        DiagnosticAuditInstallation {
            path: self.0.join("audit.jsonl"),
            max_bytes: 1024,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn request(id: u64) -> String {
    serde_json::json!({"requestId":id,"codeKind":"strings","sourceSha256":"a".repeat(64),"sourceBytes":4,"readBytes":4}).to_string()
}
#[test]
fn durable_metadata_only_append_is_bounded_and_exclusively_locked() {
    let fixture = Fixture::new();
    let config = fixture.config();
    let admission = SourceAdmission::default();
    let mut audit = NativeDiagnosticAudit::open(&config, &admission).unwrap();
    assert!(NativeDiagnosticAudit::open(&config, &admission).is_err());
    assert!(audit.record_source_read(&request(1)));
    let bytes = fs::read(&config.path).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["event"], "source.read.admitted");
    assert_eq!(value["request"]["readBytes"], 4);
    assert_eq!(value["sequence"], 1);
    assert_eq!(value["sessionId"].as_str().unwrap().len(), 32);
    assert!(value["request"].get("source").is_none());
    assert_eq!(fs::metadata(&config.path).unwrap().mode() & 0o777, 0o600);
    let mut count = 1;
    while audit.record_source_read(&request(count + 1)) {
        count += 1;
        assert!(count < 10);
    }
    assert!(fs::metadata(&config.path).unwrap().len() <= config.max_bytes);
    assert!(!audit.record_source_read(&request(99)));
    drop(audit);
    drop(admission);
    assert!(NativeDiagnosticAudit::open(&config, &SourceAdmission::default()).is_ok());
}
#[test]
fn unknown_fields_invalid_digest_and_private_file_aliases_are_rejected() {
    let fixture = Fixture::new();
    let config = fixture.config();
    let admission = SourceAdmission::default();
    let mut audit = NativeDiagnosticAudit::open(&config, &admission).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&request(1)).unwrap();
    value["source"] = serde_json::json!("private source");
    assert!(!audit.record_source_read(&value.to_string()));
    assert!(!audit.record_source_read(&request(0)));
    value.as_object_mut().unwrap().remove("source");
    value["sourceSha256"] = serde_json::json!("A".repeat(64));
    assert!(!audit.record_source_read(&value.to_string()));
    let mut source = crate::SourceStore::with_admission(&config.path, admission.clone()).unwrap();
    assert!(source.read(&source.entry_url.clone()).is_err());
    fs::hard_link(&config.path, fixture.0.join("alias")).unwrap();
    assert!(!audit.record_source_read(&request(1)));
    assert_eq!(fs::metadata(&config.path).unwrap().len(), 0);
}
#[test]
fn unsafe_directory_symlink_and_existing_public_file_fail_closed() {
    let fixture = Fixture::new();
    let config = fixture.config();
    fs::write(&config.path, b"").unwrap();
    fs::set_permissions(&config.path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(NativeDiagnosticAudit::open(&config, &SourceAdmission::default()).is_err());
    fs::remove_file(&config.path).unwrap();
    std::os::unix::fs::symlink("elsewhere", &config.path).unwrap();
    assert!(NativeDiagnosticAudit::open(&config, &SourceAdmission::default()).is_err());
    fs::remove_file(&config.path).unwrap();
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(NativeDiagnosticAudit::open(&config, &SourceAdmission::default()).is_err());
}

#[test]
fn partial_or_unknown_history_is_never_silently_appended() {
    let fixture = Fixture::new();
    let config = fixture.config();
    for bytes in ["{\"request\":", "{}\n", "\n"] {
        fs::write(&config.path, bytes).unwrap();
        fs::set_permissions(&config.path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(NativeDiagnosticAudit::open(&config, &SourceAdmission::default()).is_err());
        assert_eq!(fs::read_to_string(&config.path).unwrap(), bytes);
    }
}

#[test]
fn audit_and_source_roles_are_exclusive_in_both_directions_and_after_rebind() {
    let fixture = Fixture::new();
    let config = fixture.config();
    fs::write(&config.path, "").unwrap();
    fs::set_permissions(&config.path, fs::Permissions::from_mode(0o600)).unwrap();
    let admission = SourceAdmission::default();
    let file = File::open(&config.path).unwrap();
    let canonical = config.path.canonicalize().unwrap();
    admission.capture(&canonical, &file).unwrap();
    assert!(NativeDiagnosticAudit::open(&config, &admission).is_err());
    fs::rename(&config.path, fixture.0.join("old-source")).unwrap();
    assert!(NativeDiagnosticAudit::open(&config, &admission).is_err());
    assert!(
        !config.path.exists(),
        "must reject the reserved Host slot before creation"
    );
    let fresh = SourceAdmission::default();
    let mut audit = NativeDiagnosticAudit::open(&config, &fresh).unwrap();
    let entry = fixture.0.join("entry.mjs");
    fs::write(&entry, "export const value=42;").unwrap();
    let mut guest = crate::SourceStore::with_admission(&entry, fresh.clone()).unwrap();
    assert!(guest.read(&guest.entry_url.clone()).unwrap().is_some());
    assert!(
        fresh
            .capture(&canonical, &File::open(&config.path).unwrap())
            .is_err()
    );
    assert!(audit.record_source_read(&request(1)));
    fs::rename(&config.path, fixture.0.join("old-audit")).unwrap();
    fs::write(&config.path, "").unwrap();
    assert!(
        fresh
            .capture(&canonical, &File::open(&config.path).unwrap())
            .is_err()
    );
}
