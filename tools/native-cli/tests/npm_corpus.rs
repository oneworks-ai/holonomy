//! Published pure-JS package corpus through the Node-free standalone `holo` CLI.
//! The checked-in package source bytes are frozen from the repository's pnpm lock.
//! Each Guest program performs its own behavioral assertions.

use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
    sync::{
        OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
static EXECUTABLE: OnceLock<PathBuf> = OnceLock::new();
const LOCK_SHA256: &str = "d0e15f01c1a077f9b771ac6440dfcc3432820e378425c6a4227d1a51bb3391b8";
const ASSET_MANIFEST_SHA256: &str =
    "6662c984ea7cf6aeecdb79bf0e17001a43428409bd40fa7a77221a2184403995";

const PROGRAMS: &[&str] = &[
    "package.json",
    "index.js",
    "index-deep.js",
    "esm-entry.mjs",
    "probe-semver.js",
    "probe-semver-deep.js",
    "probe-minimatch.js",
    "probe-acorn.mjs",
    "app/package.json",
    "app/index.js",
    "app-ajv/index.js",
    "app-ajv/host.json",
    "app-ajv/gate.mjs",
    "app-release/index.mjs",
    "app-release/host.json",
    "app-release/data/releases.yaml",
    "app-config/index.mjs",
    "app-config/host.json",
    "app-config/data/config.yaml",
    "app-config/data/invalid.txt",
    "app-api-index/index.mjs",
    "app-api-index/host.json",
    "app-api-index/data/source.txt",
    "app-api-index/data/invalid.txt",
];

fn fixture_source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/npm-corpus")
}

fn holo_executable() -> &'static Path {
    EXECUTABLE.get_or_init(|| match std::env::var_os("HOLO_NPM_CORPUS_EXECUTABLE") {
        Some(path) => {
            let path = PathBuf::from(path);
            let expected = std::env::var("HOLO_NPM_CORPUS_SHA256")
                .expect("selected corpus executable requires its SHA-256 pin");
            assert_eq!(expected.len(), 64);
            let actual = format!("{:x}", Sha256::digest(fs::read(&path).unwrap()));
            assert_eq!(actual, expected, "selected corpus executable changed");
            path
        }
        None => {
            assert!(std::env::var_os("HOLO_NPM_CORPUS_SHA256").is_none());
            PathBuf::from(env!("CARGO_BIN_EXE_holo"))
        }
    })
}

fn expected_assets(source: &Path) -> BTreeMap<String, String> {
    let manifest_bytes = fs::read(source.join("package-assets.json")).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&manifest_bytes)),
        ASSET_MANIFEST_SHA256,
        "frozen package asset manifest changed"
    );
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).unwrap();
    assert_eq!(manifest["schemaVersion"], 1);
    assert_eq!(manifest["lockSha256"].as_str(), Some(LOCK_SHA256));
    let files = manifest["files"].as_array().unwrap();
    assert_eq!(files.len(), 389);
    let mut expected = BTreeMap::new();
    for file in files {
        let path = file["path"].as_str().unwrap();
        let sha256 = file["sha256"].as_str().unwrap();
        assert!(
            Path::new(path)
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
            "invalid asset path: {path}"
        );
        assert_eq!(sha256.len(), 64);
        assert!(sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(
            expected
                .insert(path.to_owned(), sha256.to_owned())
                .is_none()
        );
    }
    expected
}

fn copy_tree(
    source: &Path,
    target: &Path,
    source_root: &Path,
    expected: &BTreeMap<String, String>,
    seen: &mut BTreeSet<String>,
) {
    fs::create_dir_all(target).unwrap();
    for child in fs::read_dir(source).unwrap() {
        let child = child.unwrap();
        let source_path = child.path();
        let kind = child.file_type().unwrap();
        let target_path = if kind.is_dir() && child.file_name() == "dist_asset" {
            target.join("dist")
        } else {
            target.join(child.file_name())
        };
        if kind.is_dir() {
            copy_tree(&source_path, &target_path, source_root, expected, seen);
        } else {
            assert!(
                kind.is_file(),
                "fixture package must contain only regular files"
            );
            let relative = source_path
                .strip_prefix(source_root)
                .unwrap()
                .to_str()
                .unwrap()
                .replace(std::path::MAIN_SEPARATOR, "/");
            let bytes = fs::read(&source_path).unwrap();
            let actual = format!("{:x}", Sha256::digest(&bytes));
            assert_eq!(
                expected.get(&relative).map(String::as_str),
                Some(actual.as_str()),
                "frozen package asset changed or was added: {relative}"
            );
            assert!(seen.insert(relative));
            fs::write(target_path, bytes).unwrap();
        }
    }
}

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(app: Option<&str>) -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-npm-corpus-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let fixture = Self { root };
        let source = fixture_source();
        for name in PROGRAMS {
            let target = fixture.root.join(name);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::copy(source.join(name), target).unwrap();
        }
        let expected = expected_assets(&source);
        let mut seen = BTreeSet::new();
        let package_root = app
            .map(|name| fixture.root.join(name))
            .unwrap_or_else(|| fixture.root.clone());
        copy_tree(
            &source.join("packages"),
            &package_root.join("node_modules"),
            &source.join("packages"),
            &expected,
            &mut seen,
        );
        for path in expected.keys() {
            assert!(seen.contains(path), "frozen package asset missing: {path}");
        }
        fixture
    }

    fn run(&self, directory: &str, entry: &str, host_config: Option<&str>) -> Output {
        self.run_with_args(directory, entry, host_config, &[])
    }

    fn run_with_args(
        &self,
        directory: &str,
        entry: &str,
        host_config: Option<&str>,
        args: &[&str],
    ) -> Output {
        self.run_with_args_and_root(directory, entry, host_config, args, false)
    }

    fn run_with_args_and_root(
        &self,
        directory: &str,
        entry: &str,
        host_config: Option<&str>,
        args: &[&str],
        select_module_root: bool,
    ) -> Output {
        let mut command = Command::new(holo_executable());
        command.args(["--timeout", "15000"]);
        if select_module_root {
            command.args(["--module-root", self.root.to_str().unwrap()]);
        }
        if let Some(host_config) = host_config {
            command.args(["--host-config", host_config]);
        }
        command
            .arg(entry)
            .args(args)
            .env_clear()
            .env("PATH", "")
            .current_dir(self.root.join(directory))
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn success(entry: &str, marker: &str) {
    success_in(None, entry, marker, None);
}

fn success_in(app: Option<&str>, entry: &str, marker: &str, host_config: Option<&str>) {
    let fixture = Fixture::new(app);
    let output = fixture.run(app.unwrap_or("."), entry, host_config);
    assert!(
        output.status.success(),
        "{entry}: exit={:?}, stdout={}, stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, format!("{marker}\n").as_bytes());
    assert!(output.stderr.is_empty());
}

#[test]
fn commonjs_semver_bare_main_without_dot_slash() {
    success("./probe-semver.js", "SEMVER_OK");
}

#[test]
fn commonjs_minimatch_exports_and_nested_brace_dependencies() {
    success("./probe-minimatch.js", "MINIMATCH_OK");
}

#[test]
fn esm_acorn_conditional_exports() {
    success("./probe-acorn.mjs", "ACORN_OK");
}

#[test]
fn commonjs_semver_deep_path_control() {
    success("./probe-semver-deep.js", "SEMVER_DEEP_OK");
}

#[test]
fn mixed_cjs_esm_packages_imports_and_canonical_identity() {
    success("./index.js", "NPM_CORPUS_OK");
}

#[test]
fn mixed_cjs_esm_deep_path_control() {
    success("./index-deep.js", "NPM_CORPUS_DEEP_OK");
}

#[test]
fn cordis_plugin_lifecycle_with_standard_schema_config_from_yaml() {
    success_in(Some("app"), "./index.js", "CORDIS_YAML_APP_OK", None);
}

#[test]
fn ajv_validation_with_explicit_code_generation_policy_and_host_gate() {
    success_in(
        Some("app-ajv"),
        "./index.js",
        "AJV_APP_OK",
        Some("host.json"),
    );
}

#[test]
fn ajv_code_generation_is_denied_by_default() {
    let fixture = Fixture::new(Some("app-ajv"));
    let output = fixture.run("app-ajv", "./index.js", None);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Code generation from strings disallowed for this context"),
        "unexpected Ajv failure: {stderr}"
    );
}

#[test]
fn published_packages_select_releases_through_real_cli_argv_and_public_fs() {
    let fixture = Fixture::new(Some("app-release"));
    let output = fixture.run_with_args(
        "app-release",
        "./index.mjs",
        Some("host.json"),
        &["--range", "^1.0.0", "--path", "src/**/*.js"],
    );
    assert!(
        output.status.success(),
        "release CLI: exit={:?}, stdout={}, stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"RELEASE_CLI_OK\n");
    assert!(output.stderr.is_empty());
    let selected: serde_json::Value = serde_json::from_slice(
        &fs::read(fixture.root.join("app-release/data/selection.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        selected,
        serde_json::json!({
            "selected": [
                {"version": "1.2.0", "path": "src/core.js"},
                {"version": "1.5.0", "path": "src/sub/feature.js"}
            ],
            "sha256": "98d4c78732aeb58fb9630c843c5dc18d2fd60b978fa1cfe6c97680a8e4f0fec9"
        })
    );
}

#[test]
fn release_cli_no_match_exits_nonzero_without_publishing_an_output() {
    let fixture = Fixture::new(Some("app-release"));
    let output = fixture.run_with_args(
        "app-release",
        "./index.mjs",
        Some("host.json"),
        &["--range", "^9.0.0", "--path", "src/**/*.js"],
    );
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"NO_RELEASE_MATCH\n");
    assert!(
        !fixture
            .root
            .join("app-release/data/selection.json")
            .exists()
    );
}

#[test]
fn published_semver_cli_filters_and_sorts_versions() {
    let fixture = Fixture::new(None);
    let output = fixture.run_with_args_and_root(
        ".",
        "node_modules/semver/bin/semver.js",
        None,
        &["--range", "^1.0.0", "2.0.0", "1.5.0", "1.2.0"],
        true,
    );
    assert!(
        output.status.success(),
        "published semver CLI: exit={:?}, stdout={}, stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"1.2.0\n1.5.0\n");
    assert!(output.stderr.is_empty());
}

#[test]
fn published_semver_cli_increments_one_version() {
    let fixture = Fixture::new(None);
    let output = fixture.run_with_args_and_root(
        ".",
        "node_modules/semver/bin/semver.js",
        None,
        &["--increment", "minor", "1.2.3"],
        true,
    );
    assert!(
        output.status.success(),
        "published semver CLI: exit={:?}, stdout={}, stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"1.3.0\n");
    assert!(output.stderr.is_empty());
}

#[test]
fn published_semver_cli_no_matching_range_exits_one() {
    let fixture = Fixture::new(None);
    let output = fixture.run_with_args_and_root(
        ".",
        "node_modules/semver/bin/semver.js",
        None,
        &["--range", "^9.0.0", "1.2.3"],
        true,
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn yaml_configuration_cli_preserves_comments_and_aliases_when_promoting() {
    let fixture = Fixture::new(Some("app-config"));
    let output = fixture.run_with_args(
        "app-config",
        "./index.mjs",
        Some("host.json"),
        &["holo-fs://workspace/config.yaml", "production"],
    );
    assert!(
        output.status.success(),
        "configuration CLI: exit={:?}, stdout={}, stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"CONFIG_PROMOTION_OK\n");
    assert!(output.stderr.is_empty());
    let data = fixture.root.join("app-config/data");
    let promoted = fs::read(data.join("promoted.yaml")).unwrap();
    assert_eq!(
        promoted,
        b"# deployment settings\ndefaults: &retry\n  attempts: 3\nservice:\n  retry: *retry\n  environment: production\n  enabled: true\n"
    );
    assert_eq!(
        fs::read(data.join("config.yaml")).unwrap(),
        fs::read(fixture_source().join("app-config/data/config.yaml")).unwrap()
    );
    let receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(data.join("receipt.json")).unwrap()).unwrap();
    assert_eq!(
        receipt,
        serde_json::json!({
            "environment": "production",
            "sha256": format!("{:x}", Sha256::digest(&promoted))
        })
    );
}

#[test]
fn yaml_configuration_cli_rejects_duplicate_keys_without_output() {
    let fixture = Fixture::new(Some("app-config"));
    let output = fixture.run_with_args(
        "app-config",
        "./index.mjs",
        Some("host.json"),
        &["holo-fs://workspace/invalid.txt", "production"],
    );
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"CONFIG_INVALID:DUPLICATE_KEY\n");
    let data = fixture.root.join("app-config/data");
    assert!(!data.join("promoted.yaml").exists());
    assert!(!data.join("receipt.json").exists());
}

#[test]
fn acorn_api_index_cli_extracts_real_exports_and_publishes_source_digest() {
    let fixture = Fixture::new(Some("app-api-index"));
    let output = fixture.run_with_args(
        "app-api-index",
        "./index.mjs",
        Some("host.json"),
        &["holo-fs://workspace/source.txt", "2022"],
    );
    assert!(
        output.status.success(),
        "API index CLI: exit={:?}, stdout={}, stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"API_INDEX_OK\n");
    assert!(output.stderr.is_empty());
    let data = fixture.root.join("app-api-index/data");
    let index: serde_json::Value =
        serde_json::from_slice(&fs::read(data.join("api-index.json")).unwrap()).unwrap();
    assert_eq!(
        index,
        serde_json::json!({
            "exports": [
                { "name": "answer", "line": 3 },
                { "name": "count", "line": 5 },
                { "name": "default", "line": 6 },
                { "name": "greet", "line": 4 }
            ],
            "sha256": format!("{:x}", Sha256::digest(fs::read(data.join("source.txt")).unwrap()))
        })
    );
}

#[test]
fn acorn_api_index_cli_reports_syntax_location_without_output() {
    let fixture = Fixture::new(Some("app-api-index"));
    let output = fixture.run_with_args(
        "app-api-index",
        "./index.mjs",
        Some("host.json"),
        &["holo-fs://workspace/invalid.txt", "2022"],
    );
    assert_eq!(output.status.code(), Some(3));
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"SOURCE_INVALID:1:13\n");
    assert!(
        !fixture
            .root
            .join("app-api-index/data/api-index.json")
            .exists()
    );
}
