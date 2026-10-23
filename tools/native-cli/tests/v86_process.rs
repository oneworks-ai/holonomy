#![cfg(target_os = "macos")]

use serde_json::json;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
const BIOS: &str = "73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98";
const KERNEL: &str = "ca4d39b3035d6ba733416c82a44c8d636f3f544a13fea775a11583f482d16c78";
// Current agent image, independently matched to its production pins/manifest.
const INITRD: &str = "14079ff3d8c1d0dcd6801b60c7acc0cabea0e6572d718877a31e1393e3f80514";
const WASM: &str = "8a969d64cf8f64b8183fdcc3a2ccdb31ae5ae6db7c9fba49949106f574640a7b";

struct Fixture(PathBuf);
impl Fixture {
    fn new(asset_root: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "holo-v86-process-e2e-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        fs::write(root.join("entry.mjs"), r#"
          import { spawn } from 'node:child_process'
          const child = spawn('cat', [], { stdio: ['pipe', 'pipe', 'pipe'] })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', value => { stdout += new TextDecoder().decode(value) })
          child.stderr.on('data', value => { stderr += new TextDecoder().decode(value) })
          child.stdin.write('V86_NATIVE_PROCESS_ECHO')
          child.stdin.end()
          const [code, signal] = await new Promise(resolve => child.once('close', (...args) => resolve(args)))
          if (code !== 0 || signal !== null || stdout !== 'V86_NATIVE_PROCESS_ECHO' || stderr !== '') {
            throw new Error(`Process mismatch: ${code},${signal},${stdout},${stderr}`)
          }
          console.log('V86_NATIVE_PROCESS_OK')
        "#).unwrap();
        fs::write(
            root.join("host.json"),
            json!({
                "schemaVersion":1,
                "processProfileId":"linux",
                "sandboxPolicy":{"schemaVersion":2,"process":{
                    "access":"sandboxed",
                    "environment":{"allowedNames":[],"maxValueBytes":1024},
                    "executables":[{"executableId":"cat","argumentBytes":1024}],
                    "shell":{"access":"none"},
                    "mounts":[],"network":{"access":"none"},
                    "limits":{
                        "maxConcurrentProcesses":1,"maxTotalProcesses":1,"maxProcessTreeDepth":1,
                        "maxExecutionTimeMs":30000,"maxStdinBytes":4096,"maxStdoutBytes":4096,
                        "maxStderrBytes":4096,"maxOpenPipes":3,"maxWritableRootfsBytes":0
                    }
                }}
            })
            .to_string(),
        )
        .unwrap();
        fs::write(root.join("process-profiles.json"), json!({
            "schemaVersion":1,
            "profiles":{"linux":{
                "profile":"process-profile-v1",
                "backend":{"backendId":"experimental.v86-v1","configuration":{
                    "artifacts":{
                        "bios":{"artifactId":"seabios.bin","sha256":BIOS},
                        "kernel":{"artifactId":"kernel.bin","sha256":KERNEL},
                        "initrd":{"artifactId":"agent.cpio","sha256":INITRD},
                        "wasm":{"artifactId":"v86.wasm","sha256":WASM}
                    },
                    "memoryBytes":134217728,
                    "requiredKernelCapabilities":["process"],
                    "supervisor":{"protocolVersion":1,"execGateTimeoutMs":30000}
                }},
                "environment":{"allowedScopes":["processTree"],"defaultScope":"processTree","capabilityBridge":{"domains":[]}},
                "executables":[{"executableId":"cat","executable":{"kind":"guestPath","path":"/bin/cat"},"fixedArgs":[],"shell":false}]
            }}
        }).to_string()).unwrap();
        fs::write(root.join("process-backends.json"), json!({
            "schemaVersion":1,
            "backends":{"experimental.v86-v1":{"implementation":"builtin.v86-v1","artifactRoot":asset_root}}
        }).to_string()).unwrap();
        for name in ["process-profiles.json", "process-backends.json"] {
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o600)).unwrap();
        }
        Self(root)
    }

    fn run(&self) -> Output {
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--timeout",
                "60000",
                "--host-config",
                "host.json",
                "--process-profiles",
                "process-profiles.json",
                "--process-backends",
                "process-backends.json",
                "--experimental-v86-process",
                "entry.mjs",
            ])
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
#[ignore = "requires verified v86 production assets and the opt-in v86-backend Cargo feature"]
fn real_guest_child_process_uses_node_free_v86_and_shared_broker() {
    let asset_root = std::env::var("HOLO_V86_PRODUCTION_ASSET_ROOT")
        .expect("set HOLO_V86_PRODUCTION_ASSET_ROOT to the verified owner-private asset directory");
    let fixture = Fixture::new(&asset_root);
    let output = fixture.run();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"V86_NATIVE_PROCESS_OK\n");
    assert!(!String::from_utf8_lossy(&output.stderr).contains(&asset_root));
}

#[test]
#[ignore = "requires verified v86 production assets and the opt-in v86-backend Cargo feature"]
fn real_guest_linux_filesystem_reenters_native_fs_broker_with_process_attribution() {
    let asset_root = std::env::var("HOLO_V86_PRODUCTION_ASSET_ROOT")
        .expect("set HOLO_V86_PRODUCTION_ASSET_ROOT");
    let fixture = Fixture::new(&asset_root);
    fs::create_dir(fixture.0.join("data")).unwrap();
    fs::write(fixture.0.join("data/input"), "HOST_TO_LINUX").unwrap();
    fs::write(fixture.0.join("data/blocked"), "PRIVATE_MUST_NOT_READ").unwrap();
    let host_path = fixture.0.join("host.json");
    let mut host: serde_json::Value =
        serde_json::from_slice(&fs::read(&host_path).unwrap()).unwrap();
    host["filesystemRoots"] = json!([{ "rootId":"workspace", "hostPath":"./data" }]);
    host["sandboxPolicy"]["filesystem"] = json!({
        "access":"sandboxed", "roots":[{"rootId":"workspace","virtualUrl":"holo-fs://workspace/","symlinks":"deny","rights":["read","write","create","list"]}],
        "limits":{"maxReadBytes":1048576,"maxWriteBytes":1048576,"maxOpenHandles":8,"maxWatchers":0,"maxDirectoryEntries":32,"maxQueuedEvents":0}
    });
    host["sandboxPolicy"]["process"]["mounts"] =
        json!([{ "rootId":"workspace", "guestPath":"/workspace", "rights":["read","write"] }]);
    host["sandboxPolicy"]["process"]["executables"] = json!([{ "executableId":"cat", "argumentBytes":1024 }, {"executableId":"sh","argumentBytes":1024}]);
    host["sandboxPolicy"]["process"]["shell"] = json!({"access":"restricted","executableId":"sh"});
    host["sandboxPolicy"]["process"]["limits"]["maxTotalProcesses"] = json!(3);
    host["plugins"] = json!([{ "id":"filesystem-attribution", "use":"./plugin.mjs" }]);
    fs::write(&host_path, host.to_string()).unwrap();
    fs::write(fixture.0.join("plugin.mjs"), r#"
      export default ctx => {
        ctx.holo.intercept({source:{kind:'linuxProcess'},resource:{kind:'filesystem'}},(request,next)=>{
          const source=request.source;
          if(!source || source.linuxPid<1 || !['cat','sh'].includes(source.executableId) || !source.processResourceId) return ctx.holo.deny(request);
          if(request.resource.requested.pathSegments[0]==='blocked') return ctx.holo.deny(request);
          return next();
        },{execution:'sync'});
      }
    "#).unwrap();
    let profile_path = fixture.0.join("process-profiles.json");
    let mut profiles: serde_json::Value =
        serde_json::from_slice(&fs::read(&profile_path).unwrap()).unwrap();
    profiles["profiles"]["linux"]["backend"]["configuration"]["requiredKernelCapabilities"] =
        json!(["process", "fuse"]);
    profiles["profiles"]["linux"]["defaultShellExecutableId"] = json!("sh");
    profiles["profiles"]["linux"]["executables"] = json!([
        {"executableId":"cat","executable":{"kind":"guestPath","path":"/bin/cat"},"fixedArgs":[],"shell":false},
        {"executableId":"sh","executable":{"kind":"guestPath","path":"/bin/sh"},"fixedArgs":[],"shell":true}
    ]);
    fs::write(&profile_path, profiles.to_string()).unwrap();
    fs::write(fixture.0.join("entry.mjs"), r#"
      import assert from 'node:assert/strict';
      import {execFile,exec} from 'node:child_process';
      const run=(method,...args)=>new Promise(resolve=>method(...args,{encoding:'utf8'},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
      const read=await run(execFile,'cat',['/workspace/input']);
      assert.equal(read.error,null);assert.equal(read.stdout,'HOST_TO_LINUX');
      const write=await run(exec,'printf GUEST_TO_HOST > /workspace/output');
      assert.equal(write.error,null);assert.equal(write.stdout,'');
      const denied=await run(execFile,'cat',['/workspace/blocked']);
      assert.ok(denied.error);assert.equal(denied.stdout,'');
      console.log('V86_NATIVE_FUSE_OK');
    "#).unwrap();
    let output = fixture.run();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"V86_NATIVE_FUSE_OK\n");
    assert_eq!(
        fs::read_to_string(fixture.0.join("data/output")).unwrap(),
        "GUEST_TO_HOST"
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("data/blocked")).unwrap(),
        "PRIVATE_MUST_NOT_READ"
    );
}

#[test]
#[ignore = "requires verified v86 production assets and the opt-in v86-backend Cargo feature"]
fn real_guest_execfile_and_shell_use_verified_linux_executables() {
    let asset_root = std::env::var("HOLO_V86_PRODUCTION_ASSET_ROOT")
        .expect("set HOLO_V86_PRODUCTION_ASSET_ROOT to the verified owner-private asset directory");
    let fixture = Fixture::new(&asset_root);
    let host_path = fixture.0.join("host.json");
    let mut host: serde_json::Value =
        serde_json::from_slice(&fs::read(&host_path).unwrap()).unwrap();
    host["sandboxPolicy"]["process"]["executables"] = json!([
        {"executableId":"echo","argumentBytes":1024},
        {"executableId":"sh","argumentBytes":1024}
    ]);
    host["sandboxPolicy"]["process"]["shell"] = json!({"access":"restricted","executableId":"sh"});
    host["sandboxPolicy"]["process"]["limits"]["maxTotalProcesses"] = json!(3);
    fs::write(&host_path, host.to_string()).unwrap();
    let profile_path = fixture.0.join("process-profiles.json");
    let mut profiles: serde_json::Value =
        serde_json::from_slice(&fs::read(&profile_path).unwrap()).unwrap();
    profiles["profiles"]["linux"]["defaultShellExecutableId"] = json!("sh");
    profiles["profiles"]["linux"]["executables"] = json!([
        {"executableId":"echo","executable":{"kind":"guestPath","path":"/bin/echo"},"fixedArgs":[],"shell":false},
        {"executableId":"sh","executable":{"kind":"guestPath","path":"/bin/sh"},"fixedArgs":[],"shell":true}
    ]);
    fs::write(&profile_path, profiles.to_string()).unwrap();
    fs::write(fixture.0.join("entry.mjs"), r#"
      import { execFile, exec } from 'node:child_process'
      const file = await new Promise(resolve => execFile('echo', ['V86_EXECFILE_OK'], { encoding: 'utf8' },
        (error, stdout, stderr) => resolve({ error, stdout, stderr })))
      if (file.error !== null || file.stdout !== 'V86_EXECFILE_OK\n' || file.stderr !== '') {
        throw new Error('execFile mismatch')
      }
      const shell = await new Promise(resolve => exec('printf V86_SHELL_OK', { encoding: 'utf8' },
        (error, stdout, stderr) => resolve({ error, stdout, stderr })))
      if (shell.error !== null || shell.stdout !== 'V86_SHELL_OK' || shell.stderr !== '') {
        throw new Error('exec mismatch')
      }
      const denied = await new Promise(resolve => execFile('sh',
        ['-c', 'exec /bin/echo MUST_NOT_EXEC'], { encoding: 'utf8' },
        (error, stdout, stderr) => resolve({ error, stdout, stderr })))
      if (denied.error === null || denied.stdout.includes('MUST_NOT_EXEC') ||
          !denied.stderr.includes('Operation not permitted')) {
        throw new Error('Guest self-exec was not denied before execution')
      }
      console.log('V86_NATIVE_EXEC_OK')
    "#).unwrap();
    let output = fixture.run();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"V86_NATIVE_EXEC_OK\n");
    assert!(!String::from_utf8_lossy(&output.stderr).contains(&asset_root));
}
