//! Tests of the private native helper boundary, not public JS facade assertions.
use std::{
    io::Write,
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant},
};

fn spawn() -> Child {
    Command::new(env!("CARGO_BIN_EXE_holo"))
        .arg("__plugin_validator_v1")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn wait(mut child: Child) -> Output {
    let deadline = Instant::now() + Duration::from_secs(3);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("private helper exceeded its independent exit deadline");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    child.wait_with_output().unwrap()
}

fn run(input: &[u8]) -> Output {
    let mut child = spawn();
    let mut input_pipe = child.stdin.take().unwrap();
    input_pipe.write_all(input).unwrap();
    drop(input_pipe);
    wait(child)
}

#[test]
fn private_helper_returns_only_one_byte_without_diagnostics() {
    for (input, accepted) in [
        (br#"[{"schema":true,"config":{}}]"#.as_slice(), true),
        (br#"[{"schema":false,"config":{}}]"#.as_slice(), false),
        (
            br#"[{"schema":{"type":"string","multipleOf":0},"config":"PRIVATE_VALUE"}]"#.as_slice(),
            false,
        ),
        (b"{".as_slice(), false),
        (
            br#"[{"schema":true,"config":{},"unknown":true}]"#.as_slice(),
            false,
        ),
    ] {
        let output = run(input);
        assert!(output.status.success());
        assert_eq!(output.stdout, [u8::from(accepted)]);
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn helper_self_deadline_applies_to_incomplete_input_without_parent_supervision() {
    let child = spawn();
    // Keep stdin open: the helper must terminate its blocked read by itself.
    let output = wait(child);
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn helper_crash_is_process_local_and_a_fresh_validation_still_succeeds() {
    let mut child = spawn();
    child.kill().unwrap();
    assert!(!wait(child).status.success());
    let output = run(br#"[{"schema":true,"config":{}}]"#);
    assert!(output.status.success());
    assert_eq!(output.stdout, [1]);
}
