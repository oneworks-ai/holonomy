use serde_json::json;
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

#[test]
fn private_v3_runs_flat_alias_from_canonical_only_stage() {
    let root = std::env::temp_dir().join(format!(
        "holo-module-aliases-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let canonical = root.join("node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs");
    fs::create_dir_all(canonical.parent().unwrap()).unwrap();
    let root = root.canonicalize().unwrap();
    fs::write(root.join("entry.mjs"), "import value from 'app://workspace/node_modules/pkg/index.mjs'; console.log('V3_ALIAS_OK', value);").unwrap();
    fs::write(&canonical, "export default 23;").unwrap();
    assert!(!root.join("node_modules/pkg").exists());
    let alias_url = "app://workspace/node_modules/pkg/index.mjs";
    let canonical_url = "app://workspace/node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs";
    let launch = json!({
        "schemaVersion": 3,
        "generation": 1,
        "entry": root.join("entry.mjs"),
        "workspaceRoot": root,
        "argv": [],
        "timeout": 5000,
        "testMode": false,
        "hostConfig": null,
        "moduleAllowlist": ["app://workspace/entry.mjs", alias_url, canonical_url],
        "moduleAliases": [{"url": alias_url, "canonicalUrl": canonical_url}]
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
        .arg("__runtime")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .env("PATH", "")
        .spawn()
        .unwrap();
    writeln!(child.stdin.as_mut().unwrap(), "{launch}").unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("private v3 Runtime did not finish");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    let _ = fs::remove_dir_all(&root);
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("V3_ALIAS_OK 23"));
}
