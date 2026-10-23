use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::symlink,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver},
    },
    time::{Duration, Instant},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

#[test]
fn private_source_snapshot_command_is_one_long_lived_source_only_process() {
    let root = std::env::temp_dir().join(format!(
        "holo-source-snapshot-cli-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    fs::write(root.join("host.json"), "{\"private\":true}").unwrap();
    fs::write(root.join("entry.mjs"), "export default 7;").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
        .arg("__source_snapshot_v1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .env("PATH", "")
        .spawn()
        .unwrap();
    let requests = [
        json!({"schemaVersion":1,"id":1,"op":"init","workspaceRoot":root}),
        json!({"schemaVersion":1,"id":2,"op":"readPrivate","path":root.join("host.json"),"kind":"config"}),
        json!({"schemaVersion":1,"id":3,"op":"seal"}),
        json!({"schemaVersion":1,"id":4,"op":"readGuest","url":"app://workspace/entry.mjs"}),
        json!({"schemaVersion":1,"id":5,"op":"readGuest","url":"app://workspace/entry.mjs?revision=two"}),
        json!({"schemaVersion":1,"id":6,"op":"readGuest","url":"app://workspace/host.json?revision=one"}),
        json!({"schemaVersion":1,"id":7,"op":"close"}),
    ];
    let stdin = child.stdin.as_mut().unwrap();
    for request in requests {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("source snapshot helper did not close after EOF");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    let _ = fs::remove_dir_all(&root);
    assert!(output.status.success(), "{:?}", output.status);
    assert!(output.stderr.is_empty(), "{:?}", output.stderr);
    let replies = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(replies.len(), 7);
    assert_eq!(replies[0]["id"], 1);
    assert_eq!(replies[1]["value"]["base64"], "eyJwcml2YXRlIjp0cnVlfQ==");
    assert_eq!(replies[3]["value"]["base64"], "ZXhwb3J0IGRlZmF1bHQgNzs=");
    assert_eq!(replies[4]["value"], replies[3]["value"]);
    assert_eq!(replies[5]["code"], "source_rejected");
    assert_eq!(replies[6]["value"], true);
}

fn exchange(
    child: &mut Child,
    stdin: &mut ChildStdin,
    responses: &Receiver<String>,
    request: Value,
) -> Value {
    writeln!(stdin, "{request}").unwrap();
    let line = responses
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or_else(|_| {
            let _ = child.kill();
            panic!("source snapshot helper did not answer a package request")
        });
    serde_json::from_str(&line).unwrap()
}

#[test]
fn private_package_ops_use_one_real_source_only_helper_process() {
    let root = std::env::temp_dir().join(format!(
        "holo-source-package-cli-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let physical = root.join("node_modules/.pnpm/pkg@1/node_modules/pkg");
    fs::create_dir_all(&physical).unwrap();
    let root = root.canonicalize().unwrap();
    let physical = root.join("node_modules/.pnpm/pkg@1/node_modules/pkg");
    fs::write(physical.join("package.json"), "{\"name\":\"pkg\"}").unwrap();
    fs::write(physical.join("index.mjs"), "export default 8;").unwrap();
    symlink(
        ".pnpm/pkg@1/node_modules/pkg",
        root.join("node_modules/pkg"),
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
        .arg("__source_snapshot_v1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .env("PATH", "")
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (sender, responses) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if sender.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    let mut stdin = child.stdin.take().unwrap();
    let initialized = exchange(
        &mut child,
        &mut stdin,
        &responses,
        json!({"schemaVersion":1,"id":1,"op":"init","workspaceRoot":root}),
    );
    assert_eq!(initialized["ok"], true);
    let opened = exchange(
        &mut child,
        &mut stdin,
        &responses,
        json!({"schemaVersion":1,"id":2,"op":"openPrivatePackage","root":root,"path":root.join("node_modules/pkg/package.json")}),
    );
    assert_eq!(opened["ok"], true);
    assert_eq!(opened["value"]["rootPath"], physical.to_str().unwrap());
    let id = opened["value"]["packageId"].as_str().unwrap();
    let module = exchange(
        &mut child,
        &mut stdin,
        &responses,
        json!({"schemaVersion":1,"id":3,"op":"readPrivatePackage","packageId":id,"relativePath":"index.mjs","kind":"module"}),
    );
    assert_eq!(module["value"]["base64"], "ZXhwb3J0IGRlZmF1bHQgODs=");
    let bad = exchange(
        &mut child,
        &mut stdin,
        &responses,
        json!({"schemaVersion":1,"id":4,"op":"readPrivatePackage","packageId":id,"relativePath":"../index.mjs","kind":"module"}),
    );
    assert_eq!(bad["code"], "invalid_path");
    exchange(
        &mut child,
        &mut stdin,
        &responses,
        json!({"schemaVersion":1,"id":5,"op":"seal"}),
    );
    let guest = exchange(
        &mut child,
        &mut stdin,
        &responses,
        json!({"schemaVersion":1,"id":6,"op":"readGuestResource","url":"app://workspace/node_modules/pkg/index.mjs"}),
    );
    assert_eq!(guest["code"], "source_rejected");
    let closed = exchange(
        &mut child,
        &mut stdin,
        &responses,
        json!({"schemaVersion":1,"id":7,"op":"close"}),
    );
    assert_eq!(closed["value"], true);
    drop(stdin);
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("source snapshot helper did not close");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    reader.join().unwrap();
    assert!(output.status.success(), "{:?}", output.status);
    assert!(output.stderr.is_empty(), "{:?}", output.stderr);
    fs::remove_dir_all(root).unwrap();
}
