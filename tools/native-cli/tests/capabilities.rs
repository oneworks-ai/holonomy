use serde_json::{Value, json};
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
            "holo-capability-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("data")).unwrap();
        Self(path)
    }
    fn config(&self, rights: &[&str]) -> Value {
        self.config_with_symlinks(rights, "deny")
    }
    fn config_with_symlinks(&self, rights: &[&str], symlinks: &str) -> Value {
        json!({
            "schemaVersion":1,"sandboxPolicy":{"schemaVersion":2,"filesystem":{"access":"sandboxed","roots":[{"rootId":"workspace","virtualUrl":"holo-fs://workspace/","rights":rights,"symlinks":symlinks}],"limits":{"maxReadBytes":4096,"maxWriteBytes":4096,"maxOpenHandles":8,"maxWatchers":0,"maxDirectoryEntries":32,"maxQueuedEvents":0}},"systemInformation":{"defaultMode":"unavailable","fields":{"os.arch":{"allowedModes":["synthetic"],"maxPrecision":"exact"}}}},
            "systemProjection":{"schemaVersion":1,"fields":{"os.arch":{"mode":"synthetic","precision":"exact","value":"arm64"}}},
            "filesystemRoots":[{"rootId":"workspace","hostPath":"data"}],"context":{"schemaVersion":1,"guest":{"app":"native"},"host":{"secret":"PRIVATE_HOST_CONTEXT"}}
        })
    }
    fn run(&self, config: &Value, source: &str) -> Output {
        fs::write(self.0.join("host.json"), config.to_string()).unwrap();
        fs::write(self.0.join("entry.mjs"), source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_holo"))
            .args([
                "--timeout",
                "5000",
                "--host-config",
                "host.json",
                "entry.mjs",
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
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
fn success(output: &Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_broker_reads_writes_binary_and_projects_only_guest_context() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("data/input.txt"), "HOST_TO_GUEST").unwrap();
    let output=fixture.run(&fixture.config(&["read","write","list","create","delete"]),r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';import fsp from 'node:fs/promises';import os from 'node:os';import runtime from 'holo:runtime';
        assert.equal(os.arch(),'arm64');assert.equal(runtime.getContext().app,'native');assert.equal(runtime.getContext().secret,undefined);
        assert.equal(typeof globalThis.__holoControlHost,'undefined');assert.equal(typeof globalThis.__holoNativeHost,'undefined');
        assert.equal(fs.readFileSync('holo-fs://workspace/input.txt','utf8'),'HOST_TO_GUEST');
        await fsp.writeFile('holo-fs://workspace/output.txt','GUEST_TO_HOST');
        assert.equal((await fsp.readFile('holo-fs://workspace/output.txt')).toString('utf8'),'GUEST_TO_HOST');
        fs.writeFileSync('holo-fs://workspace/bytes.bin',Buffer.from([0,128,255]));
        assert.equal(fs.readFileSync('holo-fs://workspace/bytes.bin','hex'),'0080ff');console.log('NATIVE_PROVIDER_OK');
    "#);
    success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("NATIVE_PROVIDER_OK"));
    assert_eq!(
        fs::read_to_string(fixture.0.join("data/output.txt")).unwrap(),
        "GUEST_TO_HOST"
    );
    assert_eq!(
        fs::read(fixture.0.join("data/bytes.bin")).unwrap(),
        [0, 128, 255]
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE_HOST_CONTEXT"));
}

#[test]
fn process_environment_is_admitted_without_granting_other_process_identity_fields() {
    let fixture = Fixture::new();
    let mut config = fixture.config(&["read"]);
    config["sandboxPolicy"]["systemInformation"]["fields"]["process.env"] =
        json!({"allowedModes":["synthetic"],"maxPrecision":"exact"});
    config["systemProjection"]["fields"]["process.env"] =
        json!({"mode":"synthetic","precision":"exact","value":{"APP_SETTING":"configured"}});
    let output = fixture.run(
        &config,
        r#"
        import assert from 'node:assert/strict';
        import projected, { env, pid, execPath, versions } from 'node:process';
        assert.equal(globalThis.process,projected);
        assert.equal(env,projected.env);assert.equal(env.APP_SETTING,'configured');
        assert.equal(Object.getPrototypeOf(env),null);assert.equal(Object.isFrozen(env),true);
        assert.equal(pid,undefined);assert.equal(execPath,undefined);
        assert.throws(()=>projected.pid,{code:'ERR_ACCESS_DENIED'});
        assert.throws(()=>projected.execPath,{code:'ERR_ACCESS_DENIED'});
        assert.throws(()=>projected.cwd(),{code:'ERR_ACCESS_DENIED'});
        assert.equal(versions.node,undefined);assert.ok(versions.holonomy);assert.ok(versions.v8);
        console.log('PROCESS_ENV_ONLY_OK');
    "#,
    );
    success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("PROCESS_ENV_ONLY_OK"));
}

#[test]
fn readonly_policy_denies_sync_and_callback_writes_before_side_effects() {
    let fixture = Fixture::new();
    let output=fixture.run(&fixture.config(&["read"]),r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';
        assert.throws(()=>fs.writeFileSync('holo-fs://workspace/denied.txt','bad'),{code:'EACCES'});
        await new Promise(resolve=>fs.writeFile('holo-fs://workspace/denied.txt','bad',function(error){assert.equal(arguments.length,1);assert.equal(error.code,'EACCES');assert.equal(Object.getPrototypeOf(error),Error.prototype);resolve()}));
        assert.throws(()=>os.hostname(),{code:'ERR_ACCESS_DENIED'});console.log('POLICY_OK');
    "#);
    success(&output);
    assert!(!fixture.0.join("data/denied.txt").exists());
}

#[test]
fn native_fs_enforces_limits_and_exclusive_atomic_writes() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("data/old.txt"), "ORIGINAL").unwrap();
    let mut config = fixture.config(&["read", "write"]);
    config["sandboxPolicy"]["filesystem"]["limits"]["maxWriteBytes"] = json!(8);
    let output=fixture.run(&config,r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';
        assert.throws(()=>fs.writeFileSync('holo-fs://workspace/old.txt','TOO_LONG_TO_WRITE'),{code:'EFBIG'});
        assert.throws(()=>fs.writeFileSync('holo-fs://workspace/old.txt','other',{flag:'wx'}),{code:'EEXIST'});
        assert.equal(fs.readFileSync('holo-fs://workspace/old.txt','utf8'),'ORIGINAL');
        fs.writeFileSync('holo-fs://workspace/new.txt','created',{flag:'wx'});console.log('ATOMIC_OK');
    "#);
    success(&output);
    assert_eq!(
        fs::read_to_string(fixture.0.join("data/old.txt")).unwrap(),
        "ORIGINAL"
    );
    assert!(!fs::read_dir(fixture.0.join("data")).unwrap().any(|e| {
        e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".holo-")
    }));
}

#[test]
fn directory_metadata_and_delete_use_the_same_provider() {
    let fixture = Fixture::new();
    let output=fixture.run(&fixture.config(&["read","write","list","create","delete"]),r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';
        fs.mkdirSync('holo-fs://workspace/sub');fs.writeFileSync('holo-fs://workspace/sub/file','123');
        assert.equal(fs.statSync('holo-fs://workspace/sub').isDirectory(),true);
        assert.equal(fs.statSync('holo-fs://workspace/sub/file').size,3);
        assert.deepEqual(fs.readdirSync('holo-fs://workspace/sub'),['file']);
        const entry=fs.readdirSync('holo-fs://workspace/sub',{withFileTypes:true})[0];assert.equal(entry.name,'file');assert.equal(entry.isFile(),true);
        fs.unlinkSync('holo-fs://workspace/sub/file');assert.deepEqual(fs.readdirSync('holo-fs://workspace/sub'),[]);
        console.log('DIRECTORY_OK');
    "#);
    success(&output);
    assert!(!fixture.0.join("data/sub/file").exists());
}

#[test]
fn invalid_policy_or_configuration_prevents_entry() {
    let fixture = Fixture::new();
    let config = fixture.config(&["read"]);
    let mut invalid = config.clone();
    invalid["sandboxPolicy"]["allowEverything"] = json!(true);
    let output = fixture.run(&invalid, "console.log('ENTRY_MUST_NOT_RUN')");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let mut invalid = config;
    invalid["unexpected"] = json!(true);
    let output = fixture.run(&invalid, "console.log('ENTRY_MUST_NOT_RUN')");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn broker_isolation_survives_guest_primordial_changes_and_root_forgery() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("data/input"), "SAFE").unwrap();
    let output=fixture.run(&fixture.config(&["read"]),r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';
        const original=Array.prototype.includes;Array.prototype.includes=()=>true;
        let denied;try{fs.writeFileSync('holo-fs://workspace/forged','bad')}catch(error){denied=error.code}finally{Array.prototype.includes=original}
        assert.equal(denied,'EACCES');assert.throws(()=>fs.readFileSync('holo-fs://not-installed/private'),{code:'EACCES'});
        assert.equal(fs.readFileSync('holo-fs://workspace/input','utf8'),'SAFE');console.log('ISOLATED_OK');
    "#);
    success(&output);
    assert!(!fixture.0.join("data/forged").exists());
}

#[test]
fn native_handles_bind_permissions_offsets_quota_and_close() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("data/input"), "content").unwrap();
    let mut config = fixture.config(&["read", "write"]);
    config["sandboxPolicy"]["filesystem"]["limits"]["maxOpenHandles"] = json!(1);
    let output=fixture.run(&config,r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';import fsp from 'node:fs/promises';
        const fd=fs.openSync('holo-fs://workspace/input','r');assert.equal(typeof fd,'number');
        assert.throws(()=>fs.openSync('holo-fs://workspace/input','r'),{code:'EMFILE'});
        assert.equal(fs.readFileSync(fd,'utf8'),'content');assert.equal(fs.readFileSync(fd,'utf8'),'');
        assert.throws(()=>fs.writeFileSync(fd,'bad'),{code:'EACCES'});fs.closeSync(fd);
        assert.throws(()=>fs.readFileSync(fd),{code:'EBADF'});
        const handle=await fsp.open('holo-fs://workspace/output','w+');
        await handle.writeFile('persisted');assert.equal((await handle.stat()).size,9);await handle.close();
        await assert.rejects(handle.stat(),{code:'EBADF'});console.log('HANDLES_OK');
    "#);
    success(&output);
    assert_eq!(
        fs::read_to_string(fixture.0.join("data/output")).unwrap(),
        "persisted"
    );
}

#[test]
fn initially_aborted_native_write_has_no_side_effect() {
    let fixture = Fixture::new();
    let output=fixture.run(&fixture.config(&["read","write"]),r#"
        import assert from 'node:assert/strict';import fsp from 'node:fs/promises';
        const controller=new AbortController();controller.abort();
        await assert.rejects(fsp.writeFile('holo-fs://workspace/cancelled','bad',{signal:controller.signal}),{code:'ABORT_ERR'});
        console.log('ABORT_OK');
    "#);
    success(&output);
    assert!(!fixture.0.join("data/cancelled").exists());
}

#[test]
fn native_filesystem_does_not_follow_or_replace_denied_symlinks() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let outside = Fixture::new();
    fs::write(outside.0.join("secret"), "SECRET").unwrap();
    symlink(outside.0.join("secret"), fixture.0.join("data/link")).unwrap();
    symlink(&outside.0, fixture.0.join("data/directory-link")).unwrap();
    let output=fixture.run(&fixture.config(&["read","write","delete"]),r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';
        assert.throws(()=>fs.readFileSync('holo-fs://workspace/link'),{code:'EXDEV'});
        assert.throws(()=>fs.readFileSync('holo-fs://workspace/directory-link/secret'),{code:'EXDEV'});
        assert.throws(()=>fs.writeFileSync('holo-fs://workspace/link','bad'),{code:'EXDEV'});
        assert.throws(()=>fs.unlinkSync('holo-fs://workspace/link'),{code:'EXDEV'});
        console.log('SYMLINK_DENIED');
    "#);
    success(&output);
    assert_eq!(
        fs::read_to_string(outside.0.join("secret")).unwrap(),
        "SECRET"
    );
    assert!(
        fs::symlink_metadata(fixture.0.join("data/link"))
            .unwrap()
            .is_symlink()
    );
}

#[test]
fn native_filesystem_within_root_profile_runs_through_real_holo() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let outside = Fixture::new();
    fs::create_dir(fixture.0.join("data/source-real")).unwrap();
    fs::create_dir(fixture.0.join("data/destination-real")).unwrap();
    fs::write(fixture.0.join("data/source-real/value"), "SAFE").unwrap();
    fs::write(outside.0.join("secret"), "OUTSIDE").unwrap();
    symlink("source-real", fixture.0.join("data/source-alias")).unwrap();
    symlink("destination-real", fixture.0.join("data/destination-alias")).unwrap();
    symlink("missing", fixture.0.join("data/broken")).unwrap();
    symlink("../outside", fixture.0.join("data/escape")).unwrap();
    symlink("loop-b", fixture.0.join("data/loop-a")).unwrap();
    symlink("loop-a", fixture.0.join("data/loop-b")).unwrap();
    let output=fixture.run(&fixture.config_with_symlinks(
        &["read","write","create","list","move","delete"], "withinRoot"
    ),r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';import fsp from 'node:fs/promises';
        assert.equal(fs.readFileSync('holo-fs://workspace/source-alias/value','utf8'),'SAFE');
        assert.equal(fs.statSync('holo-fs://workspace/source-alias/value').isFile(),true);
        const fd=fs.openSync('holo-fs://workspace/source-alias/value','r');assert.equal(fs.readFileSync(fd,'utf8'),'SAFE');fs.closeSync(fd);
        assert.deepEqual(fs.readdirSync('holo-fs://workspace/source-alias'),['value']);
        assert.throws(()=>fs.readFileSync('holo-fs://workspace/broken'),{code:'ENOENT'});
        for(const name of ['escape','loop-a']){try{fs.readFileSync('holo-fs://workspace/'+name);assert.fail()}catch(error){assert.equal(error.code,'EXDEV');assert.equal(String(error).includes('/private/'),false)}}
        fs.writeFileSync('holo-fs://workspace/broken','ATOMIC');assert.equal(fs.readFileSync('holo-fs://workspace/missing','utf8'),'ATOMIC');
        fs.mkdirSync('holo-fs://workspace/source-alias/created');assert.equal(fs.statSync('holo-fs://workspace/source-real/created').isDirectory(),true);
        assert.throws(()=>fs.writeFileSync('holo-fs://workspace/source-alias/value','BAD'),{code:'EIO'});
        assert.throws(()=>fs.lstatSync('holo-fs://workspace/broken'),{code:'EIO'});
        assert.throws(()=>fs.unlinkSync('holo-fs://workspace/broken'),{code:'EIO'});
        assert.throws(()=>fs.renameSync('holo-fs://workspace/source-alias/value','holo-fs://workspace/destination-alias/value'),{code:'EIO'});
        assert.equal(fs.readFileSync('holo-fs://workspace/source-real/value','utf8'),'SAFE');
        const controller=new AbortController();controller.abort();
        await assert.rejects(fsp.writeFile('holo-fs://workspace/cancelled','bad',{signal:controller.signal}),{code:'ABORT_ERR'});
        console.log('WITHIN_ROOT_OK');
    "#);
    success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("WITHIN_ROOT_OK"));
    assert_eq!(
        fs::read_to_string(outside.0.join("secret")).unwrap(),
        "OUTSIDE"
    );
    assert!(!fixture.0.join("data/cancelled").exists());
    assert!(!fixture.0.join("data/destination-real/value").exists());
}

#[test]
fn native_rename_authorizes_both_paths_and_preserves_node_void_delivery() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("data/source"), "MOVE_ME").unwrap();
    let output=fixture.run(&fixture.config(&["read","move"]),r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';import fsp from 'node:fs/promises';
        fs.renameSync('holo-fs://workspace/source','holo-fs://workspace/target');
        assert.equal(fs.readFileSync('holo-fs://workspace/target','utf8'),'MOVE_ME');
        assert.throws(()=>fs.readFileSync('holo-fs://workspace/source'),{code:'ENOENT'});
        await fsp.rename('holo-fs://workspace/target','holo-fs://workspace/async-target');
        await new Promise(resolve=>fs.rename('holo-fs://workspace/async-target','holo-fs://workspace/final',function(error){assert.equal(arguments.length,1);assert.equal(error,null);resolve()}));
        console.log('RENAME_OK');
    "#);
    success(&output);
    assert_eq!(
        fs::read_to_string(fixture.0.join("data/final")).unwrap(),
        "MOVE_ME"
    );
    assert!(!fixture.0.join("data/source").exists());
}

fn watch_config(fixture: &Fixture) -> Value {
    let mut config = fixture.config(&["read", "write", "watch"]);
    config["sandboxPolicy"]["filesystem"]["limits"]["maxWatchers"] = json!(2);
    config["sandboxPolicy"]["filesystem"]["limits"]["maxQueuedEvents"] = json!(16);
    config
}

#[test]
fn native_watcher_delivers_os_events_and_closes_exactly_once() {
    let fixture = Fixture::new();
    let output=fixture.run(&watch_config(&fixture),r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';
        let closes=0;let changes=0;
        await new Promise(resolve=>{
            const watcher=fs.watch('holo-fs://workspace/',function(event,filename){
                assert.equal(arguments.length,2);assert.ok(['change','rename'].includes(event));assert.equal(filename,'changed');changes++;
                watcher.close();watcher.close();resolve();
            });
            watcher.on('close',function(){assert.equal(arguments.length,0);closes++});
            setTimeout(()=>fs.writeFileSync('holo-fs://workspace/changed','content'),10);
        });
        assert.equal(changes,1);assert.equal(closes,1);console.log('WATCH_OK');
    "#);
    success(&output);
    assert_eq!(
        fs::read_to_string(fixture.0.join("data/changed")).unwrap(),
        "content"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn within_root_file_watch_delivers_real_events_and_releases_abort_and_close_resources() {
    use std::{io::BufRead, os::unix::fs::symlink, process::Stdio};

    let fixture = Fixture::new();
    fs::write(fixture.0.join("data/real"), "BEFORE").unwrap();
    symlink("real", fixture.0.join("data/alias")).unwrap();
    let mut config = fixture.config_with_symlinks(&["watch"], "withinRoot");
    config["sandboxPolicy"]["filesystem"]["limits"]["maxWatchers"] = json!(1);
    config["sandboxPolicy"]["filesystem"]["limits"]["maxQueuedEvents"] = json!(4);
    fs::write(fixture.0.join("host.json"), config.to_string()).unwrap();
    fs::write(fixture.0.join("file-watch.mjs"), r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';import fsp from 'node:fs/promises';
        let closes=0;
        await new Promise(resolve=>{
            const watcher=fs.watch('holo-fs://workspace/alias',(event,filename)=>{
                assert.equal(event,'change');assert.equal(filename,'real');watcher.close();watcher.close();resolve();
            });
            watcher.on('close',()=>closes++);console.log('READY');
        });
        assert.equal(closes,1);
        const controller=new AbortController();
        const iterator=fsp.watch('holo-fs://workspace/alias',{signal:controller.signal});
        const pending=iterator.next();controller.abort();
        await assert.rejects(pending,{code:'ABORT_ERR'});
        const replacement=fs.watch('holo-fs://workspace/alias');replacement.close();
        console.log('FILE_WATCH_OK');
    "#).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args([
            "--timeout",
            "5000",
            "--host-config",
            "host.json",
            "file-watch.mjs",
        ])
        .current_dir(&fixture.0)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut reader = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert_eq!(line, "READY\n");
    fs::write(fixture.0.join("data/real"), "AFTER").unwrap();
    child.stdout = Some(reader.into_inner());
    let output = child.wait_with_output().unwrap();
    success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("FILE_WATCH_OK"));
}

#[cfg(target_os = "macos")]
#[test]
fn unreferenced_within_root_file_watch_does_not_keep_holo_alive() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    fs::write(fixture.0.join("data/real"), "VALUE").unwrap();
    symlink("real", fixture.0.join("data/alias")).unwrap();
    let mut config = fixture.config_with_symlinks(&["watch"], "withinRoot");
    config["sandboxPolicy"]["filesystem"]["limits"]["maxWatchers"] = json!(1);
    config["sandboxPolicy"]["filesystem"]["limits"]["maxQueuedEvents"] = json!(4);
    let output = fixture.run(
        &config,
        r#"
        import fs from 'node:fs';
        fs.watch('holo-fs://workspace/alias',{persistent:false});console.log('FILE_UNREF_OK');
    "#,
    );
    success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("FILE_UNREF_OK"));
}

#[cfg(target_os = "macos")]
#[test]
fn within_root_file_watch_overflow_closes_and_releases_capacity() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    fs::write(fixture.0.join("data/real"), "BEFORE").unwrap();
    symlink("real", fixture.0.join("data/alias")).unwrap();
    let mut config = fixture.config_with_symlinks(&["read", "write", "watch"], "withinRoot");
    config["sandboxPolicy"]["filesystem"]["limits"]["maxWatchers"] = json!(2);
    config["sandboxPolicy"]["filesystem"]["limits"]["maxQueuedEvents"] = json!(4);
    let output = fixture.run(&config, r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';import fsp from 'node:fs/promises';
        const path='holo-fs://workspace/alias';
        const iterator=fsp.watch(path,{maxQueuedEvents:1});
        let observed;const observer=fs.watch(path,()=>{const resolve=observed;observed=undefined;resolve?.()});
        const fd=fs.openSync(path,'r+');
        const change=value=>new Promise(resolve=>{observed=resolve;fs.writeFileSync(fd,value)});
        await change('one');await change('two');
        await assert.rejects(iterator.next(),{code:'ENOSPC'});
        const replacement=fs.watch(path);replacement.close();observer.close();fs.closeSync(fd);
        console.log('FILE_OVERFLOW_OK');
    "#);
    success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("FILE_OVERFLOW_OK"));
}

#[test]
fn native_watch_iterator_is_sync_return_and_abort_releases_capacity() {
    let fixture = Fixture::new();
    let mut config = watch_config(&fixture);
    config["sandboxPolicy"]["filesystem"]["limits"]["maxWatchers"] = json!(1);
    let output=fixture.run(&config,r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';import fsp from 'node:fs/promises';
        const iterator=fsp.watch('holo-fs://workspace/');assert.equal(typeof iterator.then,'undefined');
        const next=iterator.next();fs.writeFileSync('holo-fs://workspace/changed','one');
        const result=await next;assert.equal(result.done,false);assert.equal(result.value.sequence,1);
        await iterator.return();assert.equal((await iterator.next()).done,true);
        const controller=new AbortController();const aborted=fsp.watch('holo-fs://workspace/',{signal:controller.signal});
        const pending=aborted.next();controller.abort();await assert.rejects(pending,{code:'ABORT_ERR'});
        const replacement=fs.watch('holo-fs://workspace/');replacement.close();console.log('ITERATOR_OK');
    "#);
    success(&output);
}

#[test]
fn native_watch_queue_overflow_is_terminal_and_releases_resources() {
    let fixture = Fixture::new();
    let output=fixture.run(&watch_config(&fixture),r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';import fsp from 'node:fs/promises';
        const iterator=fsp.watch('holo-fs://workspace/',{maxQueuedEvents:1});
        let observed;const observer=fs.watch('holo-fs://workspace/',()=>observed?.());
        const change=value=>new Promise(resolve=>{observed=resolve;fs.writeFileSync('holo-fs://workspace/changed',value)});
        await change('one');await change('two');
        await assert.rejects(iterator.next(),{code:'ENOSPC'});
        const replacement=fs.watch('holo-fs://workspace/');replacement.close();observer.close();console.log('OVERFLOW_OK');
    "#);
    success(&output);
}

#[test]
fn unreferenced_native_watch_does_not_keep_the_process_alive() {
    let fixture = Fixture::new();
    let output=fixture.run(&watch_config(&fixture),r#"
        import fs from 'node:fs';fs.watch('holo-fs://workspace/',{persistent:false});console.log('UNREF_OK');
    "#);
    success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("UNREF_OK"));
}

#[test]
fn native_provider_runs_the_existing_complete_fs_conformance_file() {
    let fixture = Fixture::new();
    let mut config = watch_config(&fixture);
    config["sandboxPolicy"]["filesystem"]["roots"][0]["rights"] =
        json!(["read", "write", "create", "list", "move", "delete", "watch"]);
    fs::write(fixture.0.join("host.json"), config.to_string()).unwrap();
    fs::write(
        fixture.0.join("filesystem.test.mjs"),
        include_str!("../../../conformance/capabilities/filesystem-v1.test.mjs"),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args([
            "test",
            "--timeout",
            "5000",
            "--host-config",
            "host.json",
            "filesystem.test.mjs",
        ])
        .current_dir(&fixture.0)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["failed"], 0);
    assert_eq!(report["total"], 6);
}

#[test]
fn root_directory_listing_does_not_share_an_exhausted_descriptor_offset() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("data/file"), "value").unwrap();
    let output = fixture.run(
        &fixture.config(&["list"]),
        r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';
        assert.deepEqual(fs.readdirSync('holo-fs://workspace/'),['file']);
        assert.deepEqual(fs.readdirSync('holo-fs://workspace/'),['file']);
    "#,
    );
    success(&output);
}

#[test]
fn directory_watch_observes_external_in_place_writes() {
    use std::io::BufRead;
    use std::process::Stdio;
    let fixture = Fixture::new();
    fs::write(fixture.0.join("data/external"), "BEFORE").unwrap();
    fs::write(
        fixture.0.join("host.json"),
        watch_config(&fixture).to_string(),
    )
    .unwrap();
    fs::write(fixture.0.join("external.mjs"),r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';
        await new Promise(resolve=>{const watcher=fs.watch('holo-fs://workspace/',(_event,name)=>{
            if(name!=='external')return;assert.equal(fs.readFileSync('holo-fs://workspace/external','utf8'),'AFTER_EXTERNAL');watcher.close();resolve();
        });console.log('READY')});console.log('EXTERNAL_OK');
    "#).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args([
            "--timeout",
            "5000",
            "--host-config",
            "host.json",
            "external.mjs",
        ])
        .current_dir(&fixture.0)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut reader = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert_eq!(line, "READY\n");
    fs::write(fixture.0.join("data/external"), "AFTER_EXTERNAL").unwrap();
    child.stdout = Some(reader.into_inner());
    let output = child.wait_with_output().unwrap();
    success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("EXTERNAL_OK"));
}

#[test]
fn native_rename_rejects_cross_root_without_mutation() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("data/source"), "SAFE").unwrap();
    let output=fixture.run(&fixture.config(&["read","move"]),r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';
        assert.throws(()=>fs.renameSync('holo-fs://workspace/source','holo-fs://elsewhere/target'),{code:'EXDEV'});
    "#);
    success(&output);
    assert_eq!(
        fs::read_to_string(fixture.0.join("data/source")).unwrap(),
        "SAFE"
    );
}

#[test]
fn deleting_watched_inode_delivers_guest_error_then_close() {
    use std::io::BufRead;
    use std::process::Stdio;
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("data/gone")).unwrap();
    fs::write(
        fixture.0.join("host.json"),
        watch_config(&fixture).to_string(),
    )
    .unwrap();
    fs::write(fixture.0.join("deletion.mjs"),r#"
        import assert from 'node:assert/strict';import fs from 'node:fs';
        let failure;let closed=0;let watcher;
        await new Promise(resolve=>{watcher=fs.watch('holo-fs://workspace/gone');watcher.on('error',error=>{failure=error});watcher.on('close',()=>{closed++;resolve()});console.log('READY')});
        assert.equal(failure instanceof Error,true);assert.equal(failure.code,'ENOENT');assert.equal(closed,1);watcher.close();console.log('CLOSED_OK');
    "#).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
        .args([
            "--timeout",
            "5000",
            "--host-config",
            "host.json",
            "deletion.mjs",
        ])
        .current_dir(&fixture.0)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut reader = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert_eq!(line, "READY\n");
    fs::remove_dir(fixture.0.join("data/gone")).unwrap();
    child.stdout = Some(reader.into_inner());
    let output = child.wait_with_output().unwrap();
    success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("CLOSED_OK"));
}
