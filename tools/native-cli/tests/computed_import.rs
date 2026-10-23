#![cfg(unix)]

use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-computed-import-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("project/sub")).unwrap();
        Self(root.canonicalize().unwrap())
    }

    fn write(&self, name: &str, source: &str) {
        let path = self.0.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, source).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn digest(source: &str) -> String {
    format!("{:x}", Sha256::digest(source.as_bytes()))
}

#[test]
fn commonjs_relative_directory_require_uses_index_under_the_selected_root() {
    let fixture = Fixture::new();
    fixture.write(
        "project/node_modules/example/package.json",
        r#"{"name":"example","type":"commonjs"}"#,
    );
    fixture.write(
        "project/node_modules/example/index.js",
        "module.exports = { answer: 42 };\n",
    );
    fixture.write(
        "project/node_modules/example/bin/run.js",
        r#"
          const assert = require('node:assert/strict')
          const root = require('../')
          assert.equal(root.answer, 42)
          assert.equal(require('../index.js'), root)
          console.log('DIRECTORY_REQUIRE_PASS')
        "#,
    );
    let output = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args([
            "--timeout",
            "5000",
            "--module-root",
            "project",
            "project/node_modules/example/bin/run.js",
        ])
        .current_dir(&fixture.0)
        .env_clear()
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"DIRECTORY_REQUIRE_PASS\n");
}

#[test]
fn computed_imports_after_planning_use_live_root_reads_and_exact_gate_metadata() {
    let fixture = Fixture::new();
    let created = "export const value='CREATED';\n";
    let edited = "export const value='EDITED';\n";
    fixture.write(
        "outside.mjs",
        "export const value='OUTSIDE_SOURCE_SENTINEL';\n",
    );
    fixture.write("project/sub/edit.mjs", "export const value='OLD';\n");
    fixture.write(
        "project/sub/parent.mjs",
        "export const load = name => import('./' + name);\n",
    );
    fixture.write(
        "project/plugin.mjs",
        r#"
          export default (context, config) => {
            context.holo.engineGate(request => {
              const expected = config.expected[request.origin]
              if (request.operation !== 'runtime.module.import' ||
                  request.codeKind !== 'module' ||
                  request.entryDetail.kind !== 'dynamicImport' ||
                  request.metadataSupport.origin !== 'exact' ||
                  !expected || request.sourceSha256 !== expected.sha256 ||
                  request.sourceBytes !== expected.bytes) {
                throw Error('wrong computed import Gate metadata')
              }
              return { action: 'allow' }
            })
          }
          // PRIVATE_SOURCE_SENTINEL
        "#,
    );
    fs::hard_link(
        fixture.0.join("project/plugin.mjs"),
        fixture.0.join("project/private-alias.mjs"),
    )
    .unwrap();
    fixture.write(
        "project/host.json",
        &json!({
            "schemaVersion": 1,
            "sandboxPolicy": {
                "schemaVersion": 2,
                "codeGeneration": {
                    "strings": {"access": "none"},
                    "wasm": {"access": "none"},
                    "dynamicImport": {
                        "access": "controlled",
                        "maxSourceBytes": 4096,
                        "maxOperations": 16,
                        "decisionTimeoutMs": 1000
                    }
                }
            },
            "plugins": [{
                "id": "gate",
                "use": "./plugin.mjs",
                "config": {"expected": {
                    "app://workspace/sub/late.mjs": {
                        "sha256": digest(created), "bytes": created.len()
                    },
                    "app://workspace/sub/edit.mjs": {
                        "sha256": digest(edited), "bytes": edited.len()
                    }
                }}
            }]
        })
        .to_string(),
    );
    fixture.write(
        "project/entry.mjs",
        r#"
          import assert from 'node:assert/strict'
          import { load } from './sub/parent.mjs'
          console.log('READY_FOR_HOST')
          await new Promise(resolve => setTimeout(resolve, 500))
          assert.equal((await load('late.mjs')).value, 'CREATED')
          assert.equal((await load('edit.mjs')).value, 'EDITED')
          for (const [name, code] of [
            ['../../outside.mjs', 'ERR_HOLONOMY_MODULE_NOT_FOUND'],
            ['../private-alias.mjs', 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED']
          ]) {
            let actual
            try { await load(name) } catch (error) { actual = error.code }
            assert.equal(actual, code)
          }
          console.log('COMPUTED_IMPORT_PASS')
        "#,
    );

    let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args([
            "--timeout",
            "8000",
            "--host-config",
            "project/host.json",
            "--module-root",
            "project",
            "project/entry.mjs",
        ])
        .current_dir(&fixture.0)
        .env_clear()
        .env("PATH", "")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut first_line = String::new();
    stdout.read_line(&mut first_line).unwrap();
    if first_line == "READY_FOR_HOST\n" {
        fixture.write("project/sub/late.mjs", created);
        fixture.write("project/sub/edit.mjs", edited);
    }
    let mut rest = String::new();
    stdout.read_to_string(&mut rest).unwrap();
    let status = child.wait().unwrap();
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();

    assert_eq!(first_line, "READY_FOR_HOST\n", "stderr={stderr}");
    assert!(
        status.success(),
        "stdout={first_line}{rest} stderr={stderr}"
    );
    assert_eq!(rest, "COMPUTED_IMPORT_PASS\n");
    assert!(!stderr.contains("PRIVATE_SOURCE_SENTINEL"));
    assert!(!stderr.contains("OUTSIDE_SOURCE_SENTINEL"));
}
