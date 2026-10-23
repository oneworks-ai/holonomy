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
            "holo-callback-diagnostic-{}-{}",
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

fn failed(output: &Output) -> String {
    assert_eq!(
        output.status.code(),
        Some(1),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn next_tick_error_reports_original_message_and_guest_location_then_stops() {
    let fixture = Fixture::new(
        "process.nextTick(() => { throw new Error('tick original') });\nprocess.nextTick(() => console.log('LATE'));\n",
        "cjs",
    );
    let output = fixture.run("cjs");
    assert!(output.stdout.is_empty());
    let stderr = failed(&output);
    assert!(stderr.contains("tick original"), "{stderr}");
    assert!(
        stderr.contains("at app://workspace/index.cjs:1:"),
        "{stderr}"
    );
    assert!(!stderr.contains("holonomy:///runtime/"), "{stderr}");
    assert!(!stderr.contains("/Users/"), "{stderr}");
}

#[test]
fn timer_error_reports_original_message_and_guest_location_then_stops() {
    let fixture = Fixture::new(
        "setTimeout(() => { throw new Error('timer original') }, 0);\nsetTimeout(() => console.log('LATE'), 1);\n",
        "mjs",
    );
    let output = fixture.run("mjs");
    assert!(output.stdout.is_empty());
    let stderr = failed(&output);
    assert!(stderr.contains("timer original"), "{stderr}");
    assert!(
        stderr.contains("at app://workspace/index.mjs:1:"),
        "{stderr}"
    );
}

#[test]
fn diagnostic_does_not_invoke_guest_stack_name_or_string_hooks() {
    let fixture = Fixture::new(
        r#"
process.nextTick(() => {
  Error.prepareStackTrace = () => { console.log('PREPARE_RAN'); return 'FAKE_STACK' };
  const error = new Error('safe original');
  Object.defineProperty(error, 'stack', { get() { console.log('STACK_GETTER_RAN'); return 'FAKE_STACK' } });
  Object.defineProperty(error, 'name', { get() { console.log('NAME_GETTER_RAN'); return 'FAKE_NAME' } });
  error.toString = () => { console.log('TO_STRING_RAN'); return 'FAKE_ERROR' };
  Error.prototype.toString = () => { console.log('ERROR_TO_STRING_RAN'); return 'FAKE_ERROR' };
  Object.prototype.toString = () => { console.log('OBJECT_TO_STRING_RAN'); return 'FAKE_OBJECT' };
  Object.getOwnPropertyDescriptor = () => { console.log('OBJECT_DESCRIPTOR_RAN'); return null };
  Reflect.get = () => { console.log('REFLECT_RAN'); return 'FAKE' };
  throw error;
});
"#,
        "cjs",
    );
    let output = fixture.run("cjs");
    assert!(
        output.stdout.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = failed(&output);
    assert!(stderr.contains("safe original"), "{stderr}");
    assert!(stderr.contains("at app://workspace/index.cjs:"), "{stderr}");
    assert!(!stderr.contains("FAKE_"), "{stderr}");
}

#[test]
fn proxy_throw_uses_fixed_fallback_without_traps_or_target_message() {
    let fixture = Fixture::new(
        r#"
process.nextTick(() => {
  const error = new Error('PROXY_SECRET');
  throw new Proxy(error, {
    get() { console.log('GET_TRAP_RAN'); throw new Error('getter ran') },
    getOwnPropertyDescriptor() { console.log('DESCRIPTOR_TRAP_RAN'); throw new Error('descriptor ran') },
    ownKeys() { console.log('OWN_KEYS_TRAP_RAN'); throw new Error('own keys ran') },
  });
});
"#,
        "cjs",
    );
    let output = fixture.run("cjs");
    assert!(
        output.stdout.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = failed(&output);
    assert_eq!(
        stderr,
        "holo: Runtime callback failed (diagnostic unavailable)\n"
    );
}

#[test]
fn valid_looking_source_urls_cannot_forge_callback_locations() {
    for (extension, forged) in [
        ("cjs", "app://workspace/forged-callback.cjs"),
        ("mjs", "holo-plugins:///fake-callback.mjs"),
    ] {
        let fixture = Fixture::new(
            &format!(
                "process.nextTick(() => {{ throw new Error('CALLBACK_ORIGIN') }});\n//# sourceURL={forged}\n"
            ),
            extension,
        );
        let output = fixture.run(extension);
        assert!(output.stdout.is_empty(), "{extension}");
        let stderr = failed(&output);
        assert!(stderr.contains("CALLBACK_ORIGIN"), "{extension}: {stderr}");
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

#[test]
fn accessor_message_uses_fixed_fallback_without_getter() {
    let fixture = Fixture::new(
        r#"
process.nextTick(() => {
  const error = new Error('hidden');
  Object.defineProperty(error, 'message', { get() { console.log('MESSAGE_GETTER_RAN'); return 'LEAK' } });
  throw error;
});
"#,
        "cjs",
    );
    let output = fixture.run("cjs");
    assert!(output.stdout.is_empty());
    assert_eq!(
        failed(&output),
        "holo: Runtime callback failed (diagnostic unavailable)\n"
    );
}

#[test]
fn long_message_is_bounded() {
    let fixture = Fixture::new(
        "process.nextTick(() => { throw new Error('A'.repeat(100000)) });\n",
        "cjs",
    );
    let stderr = failed(&fixture.run("cjs"));
    assert!(stderr.contains("AAA"), "{stderr}");
    assert!(stderr.len() < 1200, "diagnostic length: {}", stderr.len());
    assert!(stderr.contains("..."), "{stderr}");
}

#[test]
fn arbitrary_object_and_number_throws_have_stable_fallbacks() {
    for source in [
        "process.nextTick(() => { throw 42 });\n",
        "process.nextTick(() => { throw { toString() { console.log('COERCION_RAN'); return 'LEAK' } } });\n",
    ] {
        let fixture = Fixture::new(source, "cjs");
        let output = fixture.run("cjs");
        assert!(output.stdout.is_empty());
        assert_eq!(
            failed(&output),
            "holo: Runtime callback failed (diagnostic unavailable)\n"
        );
    }
}

#[test]
fn original_error_cause_does_not_replace_original_message() {
    let fixture = Fixture::new(
        "process.nextTick(() => { throw new Error('OUTER', { cause: new Error('INNER') }) });\n",
        "cjs",
    );
    let stderr = failed(&fixture.run("cjs"));
    assert!(stderr.contains("OUTER"), "{stderr}");
    assert!(!stderr.contains("INNER"), "{stderr}");
}

#[test]
fn proxy_brand_check_does_not_run_any_guest_trap_or_poisoned_weakset_method() {
    let fixture = Fixture::new(
        r#"
process.nextTick(() => {
  WeakSet.prototype.has = () => { console.log('SIDE_EFFECT:WeakSet.has'); return true };
  WeakSet.prototype.add = () => { console.log('SIDE_EFFECT:WeakSet.add'); return this };
  const target = new Error('HIDDEN_PROXY_MESSAGE');
  const handler = {};
  for (const name of [
    'get', 'set', 'has', 'deleteProperty', 'defineProperty',
    'getOwnPropertyDescriptor', 'ownKeys', 'getPrototypeOf',
    'setPrototypeOf', 'isExtensible', 'preventExtensions',
    'apply', 'construct'
  ]) handler[name] = (...args) => {
    console.log(`SIDE_EFFECT:proxy:${name}`);
    return Reflect[name](...args);
  };
  throw new Proxy(target, handler);
});
"#,
        "cjs",
    );
    let output = fixture.run("cjs");
    assert!(
        output.stdout.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        failed(&output),
        "holo: Runtime callback failed (diagnostic unavailable)\n"
    );
}

#[test]
fn nested_and_revoked_proxies_use_fallback_without_internal_stack() {
    for source in [
        r#"
process.nextTick(() => {
  const handler = {
    getPrototypeOf(target) { console.log('SIDE_EFFECT:getPrototypeOf'); return Reflect.getPrototypeOf(target) },
    isExtensible(target) { console.log('SIDE_EFFECT:isExtensible'); return Reflect.isExtensible(target) },
  };
  throw new Proxy(new Proxy(new Error('HIDDEN_NESTED'), handler), handler);
});
"#,
        r#"
process.nextTick(() => {
  const { proxy, revoke } = Proxy.revocable(new Error('HIDDEN_REVOKED'), {});
  revoke();
  throw proxy;
});
"#,
    ] {
        let fixture = Fixture::new(source, "cjs");
        let output = fixture.run("cjs");
        assert!(
            output.stdout.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert_eq!(
            failed(&output),
            "holo: Runtime callback failed (diagnostic unavailable)\n"
        );
    }
}

#[test]
fn runtime_error_wrapper_does_not_invoke_guest_error_prototype_setter() {
    let fixture = Fixture::new(
        r#"
process.nextTick(() => {
  Object.defineProperty(Error.prototype, 'name', {
    configurable: true,
    get() { console.log('SIDE_EFFECT:Error.prototype.name:get'); return 'POISONED' },
    set(value) { console.log(`SIDE_EFFECT:Error.prototype.name:set:${value}`) },
  });
  throw new Error('original-message');
});
"#,
        "cjs",
    );
    let output = fixture.run("cjs");
    assert!(
        output.stdout.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = failed(&output);
    assert!(stderr.contains("original-message"), "{stderr}");
    assert!(stderr.contains("at app://workspace/index.cjs:"), "{stderr}");
}
