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
            "holo-native-crypto-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn run(&self, source: &str, test: bool) -> Output {
        fs::write(self.0.join("entry.mjs"), source).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_holo"));
        if test {
            command.arg("test");
        }
        command
            .args(["--timeout", "5000", "entry.mjs"])
            .env_clear()
            .env("PATH", "")
            .current_dir(&self.0)
            .output()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn native_crypto_runs_portable_public_js_conformance_without_node() {
    let output = Fixture::new().run(
        include_str!("../../../conformance/capabilities/crypto-v1.test.mjs"),
        true,
    );
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["passed"], 6);
    assert_eq!(report["failed"], 0);
    assert_eq!(report["platform"], "desktop");
}

#[test]
fn native_crypto_preserves_binary_and_intrinsic_boundaries() {
    let output = Fixture::new().run(include_str!("fixtures/crypto-boundaries.mjs"), false);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "NATIVE_CRYPTO_BOUNDARIES_OK\n"
    );
}
