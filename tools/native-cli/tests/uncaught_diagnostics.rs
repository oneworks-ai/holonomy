use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new(source: &str, extension: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "holo-uncaught-diagnostic-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::write(path.join(format!("index.{extension}")), source).unwrap();
        Self(path)
    }

    fn run(&self, extension: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args(["--timeout", "5000", &format!("index.{extension}")])
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

fn failed(output: &Output) -> (String, String) {
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert_eq!(output.status.code(), Some(1), "{stdout}\n{stderr}");
    (stdout, stderr)
}

#[test]
fn top_level_error_uses_native_message_and_guest_location_without_guest_hooks() {
    let fixture = Fixture::new(
        r#"
Error.prepareStackTrace = () => { console.log('PREPARE_RAN'); return 'FAKE_STACK' };
const error = new Error('safe top-level');
Object.defineProperty(error, 'stack', { get() { console.log('STACK_GETTER_RAN'); return 'FAKE_STACK' } });
Object.defineProperty(error, 'name', { get() { console.log('NAME_GETTER_RAN'); return 'FAKE_NAME' } });
error.toString = () => { console.log('TO_STRING_RAN'); return 'FAKE_ERROR' };
Error.prototype.toString = () => { console.log('ERROR_TO_STRING_RAN'); return 'FAKE_ERROR' };
Object.getOwnPropertyDescriptor = () => { console.log('DESCRIPTOR_RAN'); return null };
Promise.resolve().then(() => console.log('LATE_PROMISE'));
process.nextTick(() => console.log('LATE_TICK'));
throw error;
"#,
        "cjs",
    );
    let (stdout, stderr) = failed(&fixture.run("cjs"));
    assert!(stdout.is_empty(), "{stdout}");
    assert!(stderr.contains("safe top-level"), "{stderr}");
    assert!(stderr.contains("at app://workspace/index.cjs:"), "{stderr}");
    assert!(!stderr.contains("FAKE_"), "{stderr}");
    assert!(!stderr.contains("holonomy:///runtime/"), "{stderr}");
    assert!(!stderr.contains("/Users/"), "{stderr}");
}

#[test]
fn unhandled_rejection_uses_native_message_and_guest_location_without_guest_hooks() {
    let fixture = Fixture::new(
        r#"
Error.prepareStackTrace = () => { console.log('PREPARE_RAN'); return 'FAKE_STACK' };
const error = new Error('safe rejection');
Object.defineProperty(error, 'stack', { get() { console.log('STACK_GETTER_RAN'); return 'FAKE_STACK' } });
Object.defineProperty(error, 'name', { get() { console.log('NAME_GETTER_RAN'); return 'FAKE_NAME' } });
error.toString = () => { console.log('TO_STRING_RAN'); return 'FAKE_ERROR' };
Promise.reject(error);
Promise.resolve().then(() => console.log('PROMISE_BEFORE_REJECTION'));
process.nextTick(() => console.log('TICK_BEFORE_REJECTION'));
setTimeout(() => console.log('TIMER_AFTER_REJECTION'), 0);
"#,
        "cjs",
    );
    let (stdout, stderr) = failed(&fixture.run("cjs"));
    assert!(stdout.contains("TICK_BEFORE_REJECTION"), "{stdout}");
    assert!(stdout.contains("PROMISE_BEFORE_REJECTION"), "{stdout}");
    assert!(!stdout.contains("TIMER_AFTER_REJECTION"), "{stdout}");
    assert!(!stdout.contains("_RAN"), "{stdout}");
    assert!(stderr.contains("safe rejection"), "{stderr}");
    assert!(stderr.contains("at app://workspace/index.cjs:"), "{stderr}");
    assert!(!stderr.contains("FAKE_"), "{stderr}");
    assert!(!stderr.contains("holonomy:///runtime/"), "{stderr}");
    assert!(!stderr.contains("/Users/"), "{stderr}");
}

#[test]
fn next_tick_and_promise_handlers_can_claim_rejection_before_fatal_boundary() {
    for extension in ["cjs", "mjs"] {
        for (source, expected) in [
            (
                "const p = Promise.reject(new Error('HANDLED')); process.nextTick(() => p.catch(() => console.log('HANDLED_TICK')));",
                "HANDLED_TICK\n",
            ),
            (
                "const p = Promise.reject(new Error('HANDLED')); Promise.resolve().then(() => p.catch(() => console.log('HANDLED_PROMISE')));",
                "HANDLED_PROMISE\n",
            ),
            (
                "const p = Promise.reject(new Error('HANDLED')); Promise.resolve().then(() => process.nextTick(() => p.catch(() => console.log('HANDLED_NESTED'))));",
                "HANDLED_NESTED\n",
            ),
        ] {
            let fixture = Fixture::new(source, extension);
            let output = fixture.run(extension);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert_eq!(output.status.code(), Some(0), "{extension}: {stderr}");
            assert_eq!(stdout, expected, "{extension}: {stderr}");
            assert!(stderr.is_empty(), "{extension}: {stderr}");
        }
    }
}

#[test]
fn proxy_error_uses_fixed_fallback_without_traps_or_target_message() {
    for source in [
        r#"
const target = new Error('HIDDEN_PROXY_MESSAGE');
throw new Proxy(target, {
  get() { console.log('GET_TRAP_RAN'); throw new Error('trap') },
  getOwnPropertyDescriptor() { console.log('DESCRIPTOR_TRAP_RAN'); throw new Error('trap') },
  ownKeys() { console.log('OWN_KEYS_TRAP_RAN'); throw new Error('trap') },
});
"#,
        r#"
const target = new Error('HIDDEN_PROXY_MESSAGE');
Promise.reject(new Proxy(target, {
  get() { console.log('GET_TRAP_RAN'); throw new Error('trap') },
  getOwnPropertyDescriptor() { console.log('DESCRIPTOR_TRAP_RAN'); throw new Error('trap') },
  ownKeys() { console.log('OWN_KEYS_TRAP_RAN'); throw new Error('trap') },
}));
"#,
    ] {
        let fixture = Fixture::new(source, "cjs");
        let (stdout, stderr) = failed(&fixture.run("cjs"));
        assert!(stdout.is_empty(), "{stdout}");
        assert_eq!(
            stderr,
            "holo: Runtime execution failed (diagnostic unavailable)\n"
        );
    }
}

#[test]
fn accessor_message_and_arbitrary_objects_use_fixed_fallback() {
    for source in [
        "const error = new Error('HIDDEN'); Object.defineProperty(error, 'message', { get() { console.log('MESSAGE_GETTER_RAN'); return 'LEAK' } }); throw error;",
        "throw { toString() { console.log('COERCION_RAN'); return 'LEAK' } };",
        "throw 42;",
    ] {
        let fixture = Fixture::new(source, "cjs");
        let (stdout, stderr) = failed(&fixture.run("cjs"));
        assert!(stdout.is_empty(), "{stdout}");
        assert_eq!(
            stderr,
            "holo: Runtime execution failed (diagnostic unavailable)\n"
        );
    }
}

#[test]
fn primitive_string_and_long_error_messages_are_bounded() {
    let fixture = Fixture::new("throw 'SAFE_STRING_'.repeat(10000);", "cjs");
    let (stdout, stderr) = failed(&fixture.run("cjs"));
    assert!(stdout.is_empty(), "{stdout}");
    assert!(stderr.contains("SAFE_STRING_"), "{stderr}");
    assert!(stderr.len() < 1200, "{}", stderr.len());
    assert!(stderr.contains("..."), "{stderr}");

    let fixture = Fixture::new("throw new Error('A'.repeat(100000));", "mjs");
    let (stdout, stderr) = failed(&fixture.run("mjs"));
    assert!(stdout.is_empty(), "{stdout}");
    assert!(stderr.contains("AAA"), "{stderr}");
    assert!(stderr.len() < 1200, "{}", stderr.len());
    assert!(stderr.contains("..."), "{stderr}");
}

#[test]
fn native_error_without_own_message_keeps_guest_location_without_prototype_getter() {
    let fixture = Fixture::new(
        "Object.defineProperty(Error.prototype, 'message', { get() { console.log('PROTOTYPE_GETTER_RAN'); return 'LEAK' } }); throw new Error();",
        "cjs",
    );
    let (stdout, stderr) = failed(&fixture.run("cjs"));
    assert!(stdout.is_empty(), "{stdout}");
    assert!(stderr.starts_with("holo: Error\n"), "{stderr}");
    assert!(stderr.contains("at app://workspace/index.cjs:"), "{stderr}");
}

#[test]
fn source_url_cannot_be_reported_as_a_trusted_guest_origin() {
    let fixture = Fixture::new(
        "throw new Error('ORIGINAL');\n//# sourceURL=file:///PRIVATE_HOST_PATH.js\n",
        "mjs",
    );
    let (stdout, stderr) = failed(&fixture.run("mjs"));
    assert!(stdout.is_empty(), "{stdout}");
    assert!(stderr.contains("ORIGINAL"), "{stderr}");
    assert!(stderr.contains("at app://workspace/index.mjs:"), "{stderr}");
    assert!(!stderr.contains("PRIVATE_HOST_PATH"), "{stderr}");
    assert!(!stderr.contains("/Users/"), "{stderr}");
}

#[test]
fn valid_looking_source_urls_cannot_forge_sync_or_rejection_locations() {
    for (extension, forged) in [
        ("cjs", "app://workspace/forged-name.cjs"),
        ("mjs", "holo-plugins:///fake.mjs"),
    ] {
        for (source, sentinel) in [
            ("throw new Error('SYNC_ORIGIN');", "SYNC_ORIGIN"),
            (
                "Promise.reject(new Error('REJECT_ORIGIN'));",
                "REJECT_ORIGIN",
            ),
        ] {
            let fixture = Fixture::new(&format!("{source}\n//# sourceURL={forged}\n"), extension);
            let (stdout, stderr) = failed(&fixture.run(extension));
            assert!(stdout.is_empty(), "{extension}: {stderr}");
            assert!(stderr.contains(sentinel), "{extension}: {stderr}");
            assert!(
                stderr.contains(&format!("at app://workspace/index.{extension}:1:")),
                "{extension}: {stderr}"
            );
            assert!(!stderr.contains(forged), "{extension}: {stderr}");
            assert!(
                !stderr.contains("holonomy:///runtime/"),
                "{extension}: {stderr}"
            );
            assert!(!stderr.contains("/Users/"), "{extension}: {stderr}");
        }
    }
}

#[test]
fn native_lines_match_physical_guest_lines_with_and_without_source_url() {
    for (extension, directive) in [
        ("cjs", ""),
        ("cjs", "//# sourceURL=app://workspace/forged.cjs\n"),
        ("mjs", ""),
        ("mjs", "//# sourceURL=holo-plugins:///fake.mjs\n"),
    ] {
        let source = format!(
            "const first = 1;\nconst second = 2;\nthrow new Error('LINE_THREE');\n{directive}"
        );
        let fixture = Fixture::new(&source, extension);
        let (stdout, stderr) = failed(&fixture.run(extension));
        assert!(stdout.is_empty(), "{extension}: {stderr}");
        assert!(stderr.contains("LINE_THREE"), "{extension}: {stderr}");
        assert!(
            stderr.contains(&format!("at app://workspace/index.{extension}:3:7")),
            "{extension}: {stderr}"
        );
    }
}

#[test]
fn synchronous_cjs_throw_stops_jobs_but_esm_drains_prior_promise_jobs() {
    let source = "Promise.resolve().then(() => console.log('PROMISE_JOB'));\nprocess.nextTick(() => console.log('NEXT_TICK'));\nthrow new Error('SYNC_FAILURE');\n";
    let cjs = Fixture::new(source, "cjs");
    let (stdout, stderr) = failed(&cjs.run("cjs"));
    assert!(stdout.is_empty(), "{stdout}");
    assert!(stderr.contains("SYNC_FAILURE"), "{stderr}");

    let esm = Fixture::new(source, "mjs");
    let (stdout, stderr) = failed(&esm.run("mjs"));
    assert_eq!(stdout, "PROMISE_JOB\n");
    assert!(stderr.contains("SYNC_FAILURE"), "{stderr}");
    assert!(
        stderr.contains("at app://workspace/index.mjs:3:"),
        "{stderr}"
    );
}
