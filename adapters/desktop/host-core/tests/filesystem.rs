use holonomy_desktop_host::{FilesystemRootInstallation, NativeFilesystem};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    path: PathBuf,
    provider: NativeFilesystem,
    constraints: Value,
}
impl Fixture {
    fn new() -> Self {
        Self::with_profile("deny")
    }
    fn with_profile(symlinks: &str) -> Self {
        Self::with_profile_and_chmod(symlinks, false)
    }
    fn with_chmod(symlinks: &str) -> Self {
        Self::with_profile_and_chmod(symlinks, true)
    }
    fn with_profile_and_chmod(symlinks: &str, chmod: bool) -> Self {
        let path = std::env::temp_dir().join(format!(
            "holo-native-fs-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        let mut provider = NativeFilesystem::new(vec![FilesystemRootInstallation {
            root_id: "workspace".into(),
            host_path: path.clone(),
        }]);
        let limits = json!({"maxReadBytes":4096,"maxWriteBytes":4096,"maxOpenHandles":8,"maxWatchers":2,"maxDirectoryEntries":32,"maxQueuedEvents":8});
        let mut rights = vec!["read", "write", "list", "create", "move", "delete", "watch"];
        if chmod {
            rights.push("chmod");
        }
        let root = json!({"rootId":"workspace","rights":rights,"symlinks":symlinks,"pathPrefixSegments":[]});
        let policy = json!({"access":"sandboxed","roots":[root],"limits":limits});
        let result: Value = serde_json::from_str(
            &provider.dispatch(&json!({"kind":"install","filesystem":policy}).to_string()),
        )
        .unwrap();
        assert_eq!(result["ok"], true);
        Self {
            path,
            provider,
            constraints: json!({"roots":[root],"limits":limits}),
        }
    }
    fn call(&mut self, input: &Value) -> Value {
        serde_json::from_str(&self.provider.dispatch(&input.to_string())).unwrap()
    }
    fn rename(&self, source: Vec<&str>, destination: Vec<&str>) -> Value {
        json!({"kind":"invoke","operation":"filesystem.entry.rename","rootId":"workspace","pathSegments":source,"destinationRootId":"workspace","destinationSegments":destination,"constraints":self.constraints,"destinationConstraints":self.constraints,"arguments":{}})
    }
}

fn prepare(
    fixture: &mut Fixture,
    operation: &str,
    path: &[&str],
    arguments: Value,
    constraints: Option<Value>,
) -> Value {
    let selected = constraints.unwrap_or_else(|| fixture.constraints.clone());
    let prepared = fixture.call(&json!({
        "kind":"prepareResolution",
        "operation":operation,
        "rootId":"workspace",
        "pathSegments":path,
        "arguments":arguments,
        "constraints":selected
    }));
    if prepared["ok"] == true && prepared["value"]["required"] == true {
        let verified = fixture.call(&json!({
            "kind":"verifyResolution",
            "rootId":"workspace",
            "ticket":prepared["value"]["ticket"]
        }));
        if verified["ok"] != true {
            return verified;
        }
    }
    prepared
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn canonical_uri_segments_map_once_to_native_names_and_keep_prefix_authority() {
    let mut fixture = Fixture::new();
    for (name, encoded) in [
        ("a b.txt", "a%20b.txt"),
        ("中文😀.txt", "%E4%B8%AD%E6%96%87%F0%9F%98%80.txt"),
        ("%literal.txt", "%25literal.txt"),
        ("%2F.txt", "%252F.txt"),
        (".hidden", ".hidden"),
    ] {
        fs::write(fixture.path.join(name), format!("HOST:{name}")).unwrap();
        let result = metadata_call(
            &mut fixture,
            "filesystem.metadata.stat",
            &[encoded],
            json!({}),
            Value::Null,
            false,
        );
        assert_eq!(result["ok"], true, "{name}: {result}");
    }
    let mut selected = fixture.constraints.clone();
    selected["roots"][0]["pathPrefixSegments"] = json!(["%252F.txt"]);
    let allowed = fixture.call(&json!({
        "kind":"invoke", "operation":"filesystem.metadata.stat", "rootId":"workspace",
        "pathSegments":["%252F.txt"], "arguments":{}, "bindingId":null,
        "constraints":selected
    }));
    assert_eq!(allowed["ok"], true, "{allowed}");
    let denied = fixture.call(&json!({
        "kind":"invoke", "operation":"filesystem.metadata.stat", "rootId":"workspace",
        "pathSegments":["a%20b.txt"], "arguments":{}, "bindingId":null,
        "constraints":selected
    }));
    assert_eq!(denied["code"], "capability.denied");
    for unsafe_name in ["%2F", "%5C", "%00", "%2E%2E", "%ZZ", "%ED%A0%80"] {
        let result = metadata_call(
            &mut fixture,
            "filesystem.metadata.stat",
            &[unsafe_name],
            json!({}),
            Value::Null,
            false,
        );
        assert_eq!(
            result["code"], "resource.invalid",
            "{unsafe_name}: {result}"
        );
    }
    let made = fixture.call(&json!({
        "kind":"invoke", "operation":"filesystem.directory.create", "rootId":"workspace",
        "pathSegments":["new%20%E4%B8%AD"], "arguments":{"options":{"recursive":true}},
        "bindingId":null, "constraints":fixture.constraints
    }));
    assert_eq!(made["ok"], true, "{made}");
    assert_eq!(
        made["value"],
        json!({"kind":"path","value":"holo-fs://workspace/new%20%E4%B8%AD"})
    );
    assert!(fixture.path.join("new 中").is_dir());
    fs::write(fixture.path.join("rename %2F.txt"), "ORIGINAL").unwrap();
    let mut rename = fixture.rename(vec!["rename%20%252F.txt"], vec!["moved%20%E4%B8%AD.txt"]);
    rename["phase"] = json!("prepareRename");
    let prepared = fixture.call(&rename);
    assert_eq!(prepared["ok"], true, "{prepared}");
    assert_eq!(
        prepared["value"]["resolvedSegments"],
        json!([["rename %2F.txt"], ["moved 中.txt"]])
    );
    rename["phase"] = json!("commitRename");
    rename["ticket"] = prepared["value"]["ticket"].clone();
    assert_eq!(fixture.call(&rename)["ok"], true);
    assert_eq!(
        fs::read_to_string(fixture.path.join("moved 中.txt")).unwrap(),
        "ORIGINAL"
    );
    assert!(!fixture.path.join("rename %2F.txt").exists());
}

#[test]
fn within_root_resolution_returns_raw_native_names_without_decoding_symlink_targets() {
    let mut fixture = Fixture::with_profile("withinRoot");
    fs::write(fixture.path.join("%2F.txt"), "LITERAL").unwrap();
    std::os::unix::fs::symlink("%2F.txt", fixture.path.join("alias")).unwrap();
    let prepared = prepare(
        &mut fixture,
        "filesystem.metadata.stat",
        &["alias"],
        json!({}),
        None,
    );
    assert_eq!(prepared["ok"], true, "{prepared}");
    assert_eq!(prepared["value"]["resolvedSegments"], json!(["%2F.txt"]));
}
#[test]
fn rename_ticket_rejects_replaced_source_and_is_single_use() {
    let mut fixture = Fixture::new();
    fs::write(fixture.path.join("source"), "ORIGINAL").unwrap();
    let mut request = fixture.rename(vec!["source"], vec!["destination"]);
    request["phase"] = json!("prepareRename");
    let prepared = fixture.call(&request);
    assert_eq!(prepared["ok"], true);
    let ticket = prepared["value"]["ticket"].clone();
    assert!(fixture.path.join("source").exists());
    assert!(!fixture.path.join("destination").exists());
    fs::rename(fixture.path.join("source"), fixture.path.join("saved")).unwrap();
    fs::write(fixture.path.join("source"), "REPLACEMENT").unwrap();
    request["phase"] = json!("commitRename");
    request["ticket"] = ticket;
    assert_eq!(fixture.call(&request)["code"], "resource.stale");
    assert!(!fixture.path.join("destination").exists());
    request["phase"] = json!("prepareRename");
    let fresh = fixture.call(&request);
    request["phase"] = json!("commitRename");
    request["ticket"] = fresh["value"]["ticket"].clone();
    assert_eq!(fixture.call(&request)["ok"], true);
    assert_eq!(fixture.call(&request)["code"], "resource.stale");
    assert_eq!(
        fs::read_to_string(fixture.path.join("destination")).unwrap(),
        "REPLACEMENT"
    );
    assert_eq!(
        fs::read_to_string(fixture.path.join("saved")).unwrap(),
        "ORIGINAL"
    );
}

#[test]
fn positioned_handle_io_keeps_sequential_offset_and_enforces_bounds() {
    let mut fixture = Fixture::new();
    fs::write(fixture.path.join("data"), "0123456789").unwrap();
    let mut request = json!({"kind":"invoke","operation":"filesystem.file.open","rootId":"workspace","pathSegments":["data"],"constraints":fixture.constraints,"bindingId":null,"arguments":{"flag":"r+"}});
    let opened = fixture.call(&request);
    assert_eq!(opened["ok"], true);
    request["bindingId"] = opened["value"]["bindingId"].clone();
    request["operation"] = json!("filesystem.file.read");
    request["arguments"] = json!({});
    request["positioned"] = json!({"kind":"positionedRead","offset":3,"size":4});
    assert_eq!(fixture.call(&request)["value"]["base64"], "MzQ1Ng==");
    request["positioned"] = json!({"kind":"positionedRead","offset":9,"size":4});
    assert_eq!(fixture.call(&request)["value"]["base64"], "OQ==");
    request["positioned"] = Value::Null;
    assert_eq!(
        fixture.call(&request)["value"]["base64"],
        "MDEyMzQ1Njc4OQ=="
    );
    request["positioned"] = json!({"kind":"positionedRead","offset":0,"size":4097});
    assert_eq!(fixture.call(&request)["code"], "resource.byte_limit");
    request["positioned"] = json!({"kind":"positionedRead","offset":-1,"size":1});
    assert_eq!(fixture.call(&request)["code"], "argument.invalid");
    request["operation"] = json!("filesystem.file.write");
    request["arguments"] = json!({"data":"ABC"});
    request["positioned"] = json!({"kind":"positionedWrite","offset":2});
    assert_eq!(fixture.call(&request)["ok"], true);
    assert_eq!(
        fs::read_to_string(fixture.path.join("data")).unwrap(),
        "01ABC56789"
    );
    request["positioned"] = json!({"kind":"positionedWrite","offset":0,"unknown":true});
    assert_eq!(fixture.call(&request)["code"], "argument.invalid");
    assert_eq!(
        fs::read_to_string(fixture.path.join("data")).unwrap(),
        "01ABC56789"
    );
}
#[test]
fn rename_ticket_rejects_parent_rebinding_and_dropped_admission() {
    let mut fixture = Fixture::new();
    fs::create_dir(fixture.path.join("parent")).unwrap();
    fs::write(fixture.path.join("parent/source"), "ORIGINAL").unwrap();
    let mut request = fixture.rename(vec!["parent", "source"], vec!["destination"]);
    request["phase"] = json!("prepareRename");
    let prepared = fixture.call(&request);
    assert_eq!(prepared["ok"], true);
    fs::rename(
        fixture.path.join("parent"),
        fixture.path.join("moved-parent"),
    )
    .unwrap();
    fs::create_dir(fixture.path.join("parent")).unwrap();
    fs::write(fixture.path.join("parent/source"), "NEW").unwrap();
    request["phase"] = json!("commitRename");
    request["ticket"] = prepared["value"]["ticket"].clone();
    assert_eq!(fixture.call(&request)["code"], "resource.stale");
    assert!(fixture.path.join("moved-parent/source").exists());
    assert!(!fixture.path.join("destination").exists());
    request["phase"] = json!("prepareRename");
    let fresh = fixture.call(&request);
    let ticket = fresh["value"]["ticket"].clone();
    assert_eq!(
        fixture.call(&json!({"kind":"closeRename","ticket":ticket}))["ok"],
        true
    );
    request["phase"] = json!("commitRename");
    request["ticket"] = ticket;
    assert_eq!(fixture.call(&request)["code"], "resource.stale");
}

#[test]
fn within_root_resolves_relative_symlinks_and_rechecks_before_read() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::with_profile("withinRoot");
    fs::create_dir(fixture.path.join("target")).unwrap();
    fs::write(fixture.path.join("target/value"), "SAFE").unwrap();
    symlink("target", fixture.path.join("alias")).unwrap();
    symlink(
        fixture.path.join("target"),
        fixture.path.join("absolute-alias"),
    )
    .unwrap();

    let prepared = prepare(
        &mut fixture,
        "filesystem.file.read",
        &["alias", "value"],
        json!({"options":{"encoding":"utf8"}}),
        None,
    );
    assert_eq!(prepared["ok"], true);
    assert_eq!(
        prepared["value"]["resolvedSegments"],
        json!(["target", "value"])
    );
    assert_eq!(prepared["value"]["evidence"]["targetType"], "file");
    assert!(
        !prepared
            .to_string()
            .contains(fixture.path.to_str().unwrap())
    );
    let ticket = prepared["value"]["ticket"].clone();
    let verified = fixture.call(&json!({
        "kind":"verifyResolution","rootId":"workspace","ticket":ticket
    }));
    assert_eq!(
        verified["value"]["resolvedSegments"],
        json!(["target", "value"])
    );
    let result = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.file.read",
        "rootId":"workspace","pathSegments":["target","value"],
        "requestedSegments":["alias","value"],"resolutionTicket":ticket,
        "constraints":fixture.constraints,
        "bindingId":null,"arguments":{"options":{"encoding":"utf8"}}
    }));
    assert_eq!(result["value"], "SAFE");

    let absolute = prepare(
        &mut fixture,
        "filesystem.file.read",
        &["absolute-alias", "value"],
        json!({"options":{"encoding":"utf8"}}),
        None,
    );
    assert_eq!(absolute["ok"], true);
    assert_eq!(
        absolute["value"]["resolvedSegments"],
        json!(["target", "value"])
    );
}

#[test]
fn within_root_rejects_escape_loops_and_broken_reads_but_can_stage_broken_write_target() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::with_profile("withinRoot");
    symlink("../outside", fixture.path.join("escape")).unwrap();
    symlink("/tmp", fixture.path.join("absolute-escape")).unwrap();
    symlink("loop-b", fixture.path.join("loop-a")).unwrap();
    symlink("loop-a", fixture.path.join("loop-b")).unwrap();
    symlink("missing", fixture.path.join("broken")).unwrap();

    assert_eq!(
        prepare(
            &mut fixture,
            "filesystem.file.read",
            &["escape"],
            json!({"options":{"encoding":"utf8"}}),
            None
        )["code"],
        "resource.cross_root"
    );
    assert_eq!(
        prepare(
            &mut fixture,
            "filesystem.file.read",
            &["absolute-escape", "anything"],
            json!({"options":{"encoding":"utf8"}}),
            None
        )["code"],
        "resource.cross_root"
    );
    assert_eq!(
        prepare(
            &mut fixture,
            "filesystem.file.read",
            &["loop-a"],
            json!({"options":{"encoding":"utf8"}}),
            None
        )["code"],
        "resource.cross_root"
    );
    assert_eq!(
        prepare(
            &mut fixture,
            "filesystem.file.read",
            &["broken"],
            json!({"options":{"encoding":"utf8"}}),
            None
        )["code"],
        "resource.not_found"
    );
    let write = prepare(
        &mut fixture,
        "filesystem.file.write",
        &["broken"],
        json!({"data":"NEW","options":{"encoding":"utf8","flag":"w"}}),
        None,
    );
    assert_eq!(write["ok"], true);
    assert_eq!(write["value"]["resolvedSegments"], json!(["missing"]));
    assert_eq!(write["value"]["evidence"]["targetType"], "missing");
}

#[test]
fn within_root_rejects_parent_and_target_replacement_and_alias_only_authority() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::with_profile("withinRoot");
    fs::create_dir(fixture.path.join("target")).unwrap();
    fs::write(fixture.path.join("target/value"), "ORIGINAL").unwrap();
    symlink("target", fixture.path.join("alias")).unwrap();

    let prepared = prepare(
        &mut fixture,
        "filesystem.file.read",
        &["alias", "value"],
        json!({"options":{"encoding":"utf8"}}),
        None,
    );
    fs::rename(
        fixture.path.join("target/value"),
        fixture.path.join("target/saved"),
    )
    .unwrap();
    fs::write(fixture.path.join("target/value"), "REPLACEMENT").unwrap();
    let pinned_leaf = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.file.read",
        "rootId":"workspace","pathSegments":["target","value"],
        "requestedSegments":["alias","value"],
        "resolutionTicket":prepared["value"]["ticket"],
        "constraints":fixture.constraints,"bindingId":null,
        "arguments":{"options":{"encoding":"utf8"}}
    }));
    assert_eq!(pinned_leaf["ok"], true);
    assert_eq!(pinned_leaf["value"], "ORIGINAL");
    assert_eq!(
        fs::read_to_string(fixture.path.join("target/value")).unwrap(),
        "REPLACEMENT"
    );

    let alias_constraints = json!({
        "roots":[{"rootId":"workspace","rights":["read"],"symlinks":"withinRoot","pathPrefixSegments":["alias"]}],
        "limits":fixture.constraints["limits"]
    });
    let prepared = prepare(
        &mut fixture,
        "filesystem.file.read",
        &["alias", "value"],
        json!({"options":{"encoding":"utf8"}}),
        Some(alias_constraints.clone()),
    );
    assert_eq!(prepared["ok"], true);
    let denied = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.file.read",
        "rootId":"workspace","pathSegments":["target","value"],
        "requestedSegments":["alias","value"],
        "resolutionTicket":prepared["value"]["ticket"],
        "constraints":alias_constraints,"bindingId":null,
        "arguments":{"options":{"encoding":"utf8"}}
    }));
    assert_eq!(denied["code"], "capability.denied");

    let parent = prepare(
        &mut fixture,
        "filesystem.file.read",
        &["alias", "value"],
        json!({"options":{"encoding":"utf8"}}),
        None,
    );
    fs::rename(fixture.path.join("target"), fixture.path.join("old-target")).unwrap();
    fs::create_dir(fixture.path.join("target")).unwrap();
    fs::write(fixture.path.join("target/value"), "NEW_PARENT").unwrap();
    let pinned_parent = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.file.read",
        "rootId":"workspace","pathSegments":["target","value"],
        "requestedSegments":["alias","value"],
        "resolutionTicket":parent["value"]["ticket"],
        "constraints":fixture.constraints,"bindingId":null,
        "arguments":{"options":{"encoding":"utf8"}}
    }));
    assert_eq!(pinned_parent["ok"], true);
    assert_eq!(pinned_parent["value"], "REPLACEMENT");
    assert_eq!(
        fs::read_to_string(fixture.path.join("target/value")).unwrap(),
        "NEW_PARENT"
    );
}

#[test]
fn within_root_missing_write_never_replaces_concurrent_leaf() {
    let mut fixture = Fixture::with_profile("withinRoot");
    let prepared = prepare(
        &mut fixture,
        "filesystem.file.write",
        &["concurrent"],
        json!({"data":"GUEST","options":{"encoding":"utf8","flag":"w"}}),
        None,
    );
    assert_eq!(prepared["ok"], true);

    fs::write(fixture.path.join("concurrent"), "EXTERNAL").unwrap();
    let result = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.file.write",
        "rootId":"workspace","pathSegments":["concurrent"],
        "requestedSegments":["concurrent"],
        "resolutionTicket":prepared["value"]["ticket"],
        "constraints":fixture.constraints,"bindingId":null,
        "arguments":{"data":"GUEST","options":{"encoding":"utf8","flag":"w"}}
    }));
    assert_eq!(result["code"], "resource.exists");
    assert_eq!(
        fs::read_to_string(fixture.path.join("concurrent")).unwrap(),
        "EXTERNAL"
    );
    assert!(!fs::read_dir(&fixture.path).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".holo-")
    }));
}

#[test]
fn within_root_writable_open_validates_before_truncate_and_uses_pinned_fd() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::with_profile("withinRoot");
    fs::write(fixture.path.join("target"), "AUTHORIZED").unwrap();
    symlink("target", fixture.path.join("alias")).unwrap();
    let prepared = prepare(
        &mut fixture,
        "filesystem.file.open",
        &["alias"],
        json!({"flag":"w"}),
        None,
    );
    assert_eq!(prepared["ok"], true);
    assert_eq!(
        fs::read_to_string(fixture.path.join("target")).unwrap(),
        "AUTHORIZED"
    );

    fs::rename(
        fixture.path.join("target"),
        fixture.path.join("authorized-moved"),
    )
    .unwrap();
    fs::write(fixture.path.join("target"), "UNAUTHORIZED").unwrap();
    let opened = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.file.open",
        "rootId":"workspace","pathSegments":["target"],"requestedSegments":["alias"],
        "resolutionTicket":prepared["value"]["ticket"],"constraints":fixture.constraints,
        "bindingId":null,"arguments":{"flag":"w"}
    }));
    assert_eq!(opened["ok"], true);
    assert_eq!(
        fs::read_to_string(fixture.path.join("target")).unwrap(),
        "UNAUTHORIZED"
    );
    assert_eq!(
        fs::read_to_string(fixture.path.join("authorized-moved")).unwrap(),
        ""
    );
    assert_eq!(
        fixture.call(&json!({
            "kind":"close","bindingId":opened["value"]["bindingId"]
        }))["ok"],
        true
    );
}

#[test]
fn within_root_safe_writes_cancel_cleanup_and_namespace_fail_closed() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::with_profile("withinRoot");
    fs::create_dir(fixture.path.join("source-real")).unwrap();
    fs::create_dir(fixture.path.join("destination-real")).unwrap();
    fs::write(fixture.path.join("source-real/value"), "MOVE").unwrap();
    symlink("source-real", fixture.path.join("source-alias")).unwrap();
    symlink("destination-real", fixture.path.join("destination-alias")).unwrap();
    symlink("missing-write", fixture.path.join("write-alias")).unwrap();
    symlink("missing-lstat", fixture.path.join("broken-lstat")).unwrap();

    let readonly = json!({
        "roots":[{"rootId":"workspace","rights":["read"],"symlinks":"withinRoot","pathPrefixSegments":[]}],
        "limits":fixture.constraints["limits"]
    });
    assert_eq!(
        prepare(
            &mut fixture,
            "filesystem.file.write",
            &["readonly-denied"],
            json!({"data":"BAD","options":{"encoding":"utf8","flag":"w"}}),
            Some(readonly)
        )["code"],
        "capability.denied"
    );
    assert!(!fixture.path.join("readonly-denied").exists());

    let existing_write = prepare(
        &mut fixture,
        "filesystem.file.write",
        &["source-alias", "value"],
        json!({"data":"BAD","options":{"encoding":"utf8","flag":"w"}}),
        None,
    );
    assert_eq!(existing_write["code"], "provider.unavailable");
    assert_eq!(
        fs::read_to_string(fixture.path.join("source-real/value")).unwrap(),
        "MOVE"
    );

    let write = prepare(
        &mut fixture,
        "filesystem.file.write",
        &["write-alias"],
        json!({"data":"ATOMIC","options":{"encoding":"utf8","flag":"w"}}),
        None,
    );
    let write_result = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.file.write",
        "rootId":"workspace","pathSegments":["missing-write"],
        "requestedSegments":["write-alias"],"resolutionTicket":write["value"]["ticket"],
        "constraints":fixture.constraints,"bindingId":null,
        "arguments":{"data":"ATOMIC","options":{"encoding":"utf8","flag":"w"}}
    }));
    assert_eq!(write_result["ok"], true);
    assert_eq!(
        fs::read_to_string(fixture.path.join("missing-write")).unwrap(),
        "ATOMIC"
    );

    let cancelled = prepare(
        &mut fixture,
        "filesystem.file.write",
        &["cancelled"],
        json!({"data":"BAD","options":{"encoding":"utf8","flag":"w"}}),
        None,
    );
    let ticket = cancelled["value"]["ticket"].clone();
    assert_eq!(
        fixture.call(&json!({"kind":"closeResolution","ticket":ticket}))["ok"],
        true
    );
    let after_close = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.file.write",
        "rootId":"workspace","pathSegments":["cancelled"],
        "requestedSegments":["cancelled"],"resolutionTicket":ticket,
        "constraints":fixture.constraints,"bindingId":null,
        "arguments":{"data":"BAD","options":{"encoding":"utf8","flag":"w"}}
    }));
    assert_eq!(after_close["code"], "resource.stale");
    assert!(!fixture.path.join("cancelled").exists());

    let lstat = prepare(
        &mut fixture,
        "filesystem.metadata.lstat",
        &["broken-lstat"],
        json!({}),
        None,
    );
    assert_eq!(lstat["code"], "provider.unavailable");

    let mut rename = fixture.rename(
        vec!["source-alias", "value"],
        vec!["destination-alias", "value"],
    );
    rename["phase"] = json!("prepareRename");
    let prepared = fixture.call(&rename);
    assert_eq!(prepared["code"], "provider.unavailable");
    assert_eq!(
        fs::read_to_string(fixture.path.join("source-real/value")).unwrap(),
        "MOVE"
    );
    assert!(!fixture.path.join("destination-real/value").exists());
}

#[test]
fn within_root_covers_directory_open_unlink_and_watch_paths() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::with_profile("withinRoot");
    fs::create_dir(fixture.path.join("target")).unwrap();
    fs::write(fixture.path.join("target/value"), "VALUE").unwrap();
    symlink("target", fixture.path.join("alias")).unwrap();
    symlink("target/value", fixture.path.join("file-alias")).unwrap();

    let listing = prepare(
        &mut fixture,
        "filesystem.directory.read",
        &["alias"],
        json!({"options":{"withFileTypes":false}}),
        None,
    );
    let listed = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.directory.read",
        "rootId":"workspace","pathSegments":["target"],"requestedSegments":["alias"],
        "resolutionTicket":listing["value"]["ticket"],"constraints":fixture.constraints,
        "bindingId":null,"arguments":{"options":{"withFileTypes":false}}
    }));
    assert_eq!(listed["value"], json!(["value"]));

    let mkdir = prepare(
        &mut fixture,
        "filesystem.directory.create",
        &["alias", "new", "nested"],
        json!({"options":{"recursive":true}}),
        None,
    );
    assert_eq!(mkdir["code"], "provider.unavailable");
    assert!(!fixture.path.join("target/new").exists());

    let mkdir = prepare(
        &mut fixture,
        "filesystem.directory.create",
        &["alias", "single"],
        json!({"options":{"recursive":true}}),
        None,
    );
    let made = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.directory.create",
        "rootId":"workspace","pathSegments":["target","single"],
        "requestedSegments":["alias","single"],
        "resolutionTicket":mkdir["value"]["ticket"],"constraints":fixture.constraints,
        "bindingId":null,"arguments":{"options":{"recursive":true}}
    }));
    assert_eq!(made["ok"], true);
    assert!(fixture.path.join("target/single").is_dir());

    let open = prepare(
        &mut fixture,
        "filesystem.file.open",
        &["alias", "value"],
        json!({"flag":"r"}),
        None,
    );
    let opened = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.file.open",
        "rootId":"workspace","pathSegments":["target","value"],
        "requestedSegments":["alias","value"],"resolutionTicket":open["value"]["ticket"],
        "constraints":fixture.constraints,"bindingId":null,"arguments":{"flag":"r"}
    }));
    assert_eq!(opened["ok"], true);
    let binding = opened["value"]["bindingId"].clone();
    assert_eq!(
        fixture.call(&json!({"kind":"close","bindingId":binding}))["ok"],
        true
    );

    let unlink = prepare(
        &mut fixture,
        "filesystem.entry.unlink",
        &["file-alias"],
        json!({}),
        None,
    );
    assert_eq!(unlink["code"], "provider.unavailable");
    assert!(fixture.path.join("file-alias").exists());
    assert_eq!(
        fs::read_to_string(fixture.path.join("target/value")).unwrap(),
        "VALUE"
    );

    let watch = prepare(
        &mut fixture,
        "filesystem.watch.subscribe",
        &["alias"],
        json!({"options":{"recursive":false,"persistent":false,"maxQueuedEvents":4}}),
        None,
    );
    let watched = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.watch.subscribe",
        "rootId":"workspace","pathSegments":["target"],"requestedSegments":["alias"],
        "resolutionTicket":watch["value"]["ticket"],"constraints":fixture.constraints,
        "bindingId":null,
        "arguments":{"options":{"recursive":false,"persistent":false,"maxQueuedEvents":4}}
    }));
    assert_eq!(watched["ok"], true);
    assert_eq!(
        fixture.call(&json!({
            "kind":"closeWatch","bindingId":watched["value"]["bindingId"]
        }))["ok"],
        true
    );
}

#[cfg(target_os = "macos")]
#[test]
fn within_root_file_watch_stays_on_pinned_inode_after_alias_and_ancestor_replacement() {
    use std::{
        os::unix::fs::symlink,
        thread,
        time::{Duration, Instant},
    };

    let mut fixture = Fixture::with_profile("withinRoot");
    let outside = Fixture::new();
    fs::create_dir(fixture.path.join("target")).unwrap();
    fs::write(fixture.path.join("target/file"), "ORIGINAL").unwrap();
    fs::write(outside.path.join("file"), "OUTSIDE").unwrap();
    symlink("target/file", fixture.path.join("alias")).unwrap();
    fixture.constraints["limits"]["maxWatchers"] = json!(1);
    let options = json!({"options":{"recursive":false,"persistent":false,"maxQueuedEvents":4}});

    let listed = prepare(
        &mut fixture,
        "filesystem.directory.read",
        &["alias"],
        json!({"options":{}}),
        None,
    );
    assert_eq!(listed["code"], "provider.unavailable");

    fixture.constraints["roots"][0]["rights"] = json!(["watch"]);

    let prepared = prepare(
        &mut fixture,
        "filesystem.watch.subscribe",
        &["alias"],
        options.clone(),
        None,
    );
    assert_eq!(prepared["ok"], true);
    assert_eq!(
        prepared["value"]["resolvedSegments"],
        json!(["target", "file"])
    );
    assert_eq!(prepared["value"]["evidence"]["targetType"], "file");

    // Both the requested alias and the resolved ancestor now point outside the root.
    // Execute must consume the verified file descriptor, not either mutable name.
    fs::rename(fixture.path.join("target"), fixture.path.join("held")).unwrap();
    symlink(&outside.path, fixture.path.join("target")).unwrap();
    fs::remove_file(fixture.path.join("alias")).unwrap();
    symlink(outside.path.join("file"), fixture.path.join("alias")).unwrap();
    let watched = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.watch.subscribe",
        "rootId":"workspace","pathSegments":["target","file"],
        "requestedSegments":["alias"],
        "resolutionTicket":prepared["value"]["ticket"],
        "constraints":fixture.constraints,"bindingId":null,"arguments":options
    }));
    assert_eq!(watched["ok"], true);
    let binding = watched["value"]["bindingId"].clone();

    fs::write(fixture.path.join("held/file"), "CHANGED").unwrap();
    let until = Instant::now() + Duration::from_secs(2);
    let changed = loop {
        let poll = fixture.call(&json!({"kind":"poll"}));
        assert_eq!(poll["ok"], true);
        if !poll["value"].as_array().unwrap().is_empty() {
            break poll["value"].clone();
        }
        assert!(
            Instant::now() < until,
            "pinned file watch produced no event"
        );
        thread::sleep(Duration::from_millis(10));
    };
    assert!(changed.as_array().unwrap().iter().any(|entry| {
        entry["bindingId"] == binding
            && entry["event"]["event"] == "change"
            && entry["event"]["tuple"] == json!(["change", "file"])
    }));
    assert_eq!(fixture.call(&json!({"kind":"poll"}))["value"], json!([]));

    fs::write(outside.path.join("file"), "OUTSIDE_CHANGED").unwrap();
    thread::sleep(Duration::from_millis(50));
    assert_eq!(fixture.call(&json!({"kind":"poll"}))["value"], json!([]));
    assert_eq!(
        fs::read_to_string(fixture.path.join("held/file")).unwrap(),
        "CHANGED"
    );

    fs::remove_file(fixture.path.join("held/file")).unwrap();
    let until = Instant::now() + Duration::from_secs(2);
    let terminal = loop {
        let poll = fixture.call(&json!({"kind":"poll"}));
        assert_eq!(poll["ok"], true);
        if !poll["value"].as_array().unwrap().is_empty() {
            break poll["value"].clone();
        }
        assert!(Instant::now() < until, "deleted file watch did not close");
        thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(terminal[0]["event"]["event"], "error");
    assert_eq!(terminal[0]["event"]["tuple"][0]["code"], "ENOENT");
    assert_eq!(terminal[1]["event"]["event"], "close");

    fs::write(fixture.path.join("held/replacement"), "NEW").unwrap();
    let replacement = prepare(
        &mut fixture,
        "filesystem.watch.subscribe",
        &["held", "replacement"],
        json!({"options":{"persistent":false}}),
        None,
    );
    assert_eq!(replacement["ok"], true);
    let opened = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.watch.subscribe",
        "rootId":"workspace","pathSegments":["held","replacement"],
        "requestedSegments":["held","replacement"],
        "resolutionTicket":replacement["value"]["ticket"],
        "constraints":fixture.constraints,"bindingId":null,
        "arguments":{"options":{"persistent":false}}
    }));
    assert_eq!(opened["ok"], true);
    for _ in 0..2 {
        assert_eq!(
            fixture.call(&json!({
                "kind":"closeWatch","bindingId":opened["value"]["bindingId"]
            }))["ok"],
            true
        );
    }
    assert_eq!(fixture.call(&json!({"kind":"poll"}))["value"], json!([]));
}

fn metadata_call(
    fixture: &mut Fixture,
    operation: &str,
    path: &[&str],
    arguments: Value,
    binding_id: Value,
    linux_process: bool,
) -> Value {
    fixture.call(&json!({
        "kind":"invoke", "operation":operation,
        "rootId":"workspace", "pathSegments":path,
        "arguments":arguments, "bindingId":binding_id,
        "constraints":fixture.constraints,
        "linuxProcess":linux_process
    }))
}

#[test]
fn metadata_mutations_are_real_bounded_and_return_same_descriptor_stats() {
    let mut fixture = Fixture::new();
    fs::write(fixture.path.join("file"), b"abcdef").unwrap();
    let path = "holo-fs://workspace/file";

    let denied = metadata_call(
        &mut fixture,
        "filesystem.file.truncate",
        &["file"],
        json!({"path":path,"len":2,"readback":true}),
        Value::Null,
        false,
    );
    assert_eq!(denied["code"], "capability.denied");
    assert_eq!(fs::read(fixture.path.join("file")).unwrap(), b"abcdef");

    let oversized = metadata_call(
        &mut fixture,
        "filesystem.file.truncate",
        &["file"],
        json!({"path":path,"len":4097,"readback":true}),
        Value::Null,
        true,
    );
    assert_eq!(oversized["code"], "resource.byte_limit");
    assert_eq!(fs::read(fixture.path.join("file")).unwrap(), b"abcdef");

    let truncated = metadata_call(
        &mut fixture,
        "filesystem.file.truncate",
        &["file"],
        json!({"path":path,"len":2,"readback":true}),
        Value::Null,
        true,
    );
    assert_eq!(truncated["ok"], true);
    assert_eq!(truncated["value"]["size"], 2);
    assert_eq!(fs::read(fixture.path.join("file")).unwrap(), b"ab");

    let times = json!({
        "path":path,
        "atime":{"kind":"set","seconds":1700000000,"nanoseconds":123456789},
        "mtime":{"kind":"set","seconds":1700000001,"nanoseconds":987654321},
        "readback":true
    });
    let changed = metadata_call(
        &mut fixture,
        "filesystem.metadata.utimes",
        &["file"],
        times,
        Value::Null,
        true,
    );
    assert_eq!(changed["ok"], true);
    assert_eq!(changed["value"]["atimeNs"], "1700000000123456789");
    assert_eq!(changed["value"]["mtimeNs"], "1700000001987654321");
    assert_eq!(changed["value"]["kind"], "file");

    let invalid = metadata_call(
        &mut fixture,
        "filesystem.metadata.utimes",
        &["file"],
        json!({
            "path":path,
            "atime":{"kind":"set","seconds":1,"nanoseconds":1000000000},
            "mtime":{"kind":"omit"},"readback":true
        }),
        Value::Null,
        true,
    );
    assert_eq!(invalid["code"], "argument.invalid");
    assert_eq!(fs::read(fixture.path.join("file")).unwrap(), b"ab");
}

#[test]
fn chmod_requires_its_own_right_rejects_special_bits_and_reports_real_mode() {
    use std::os::unix::fs::PermissionsExt;
    let mut denied = Fixture::new();
    fs::write(denied.path.join("file"), b"data").unwrap();
    let path = "holo-fs://workspace/file";
    let request = json!({"path":path,"mode":0o600});
    let result = metadata_call(
        &mut denied,
        "filesystem.metadata.chmod",
        &["file"],
        request.clone(),
        Value::Null,
        false,
    );
    assert_eq!(result["code"], "capability.denied");
    let opened = metadata_call(
        &mut denied,
        "filesystem.file.open",
        &["file"],
        json!({"flag":"r"}),
        Value::Null,
        false,
    );
    assert_eq!(opened["ok"], true, "{opened}");
    let denied_fd = metadata_call(
        &mut denied,
        "filesystem.metadata.chmod",
        &["file"],
        json!({"mode":0o600}),
        opened["value"]["bindingId"].clone(),
        false,
    );
    assert_eq!(denied_fd["code"], "capability.denied");

    let mut fixture = Fixture::with_chmod("deny");
    let file = fixture.path.join("file");
    fs::write(&file, b"data").unwrap();
    fixture.constraints["roots"][0]["rights"] = json!(["write"]);
    let result = metadata_call(
        &mut fixture,
        "filesystem.metadata.chmod",
        &["file"],
        request.clone(),
        Value::Null,
        false,
    );
    assert_eq!(result["code"], "capability.denied");
    fixture.constraints["roots"][0]["rights"] = json!(["chmod"]);

    let original = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
    for mode in [
        json!(-1),
        json!(0o100644),
        json!(0o4755),
        json!("0644"),
        json!(0.5),
    ] {
        let result = metadata_call(
            &mut fixture,
            "filesystem.metadata.chmod",
            &["file"],
            json!({"path":path,"mode":mode}),
            Value::Null,
            false,
        );
        assert_eq!(result["code"], "argument.invalid", "{mode}: {result}");
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            original
        );
    }
    let denied_readback = metadata_call(
        &mut fixture,
        "filesystem.metadata.chmod",
        &["file"],
        json!({"path":path,"mode":0o600,"readback":true}),
        Value::Null,
        false,
    );
    assert_eq!(denied_readback["code"], "capability.denied");
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        original
    );

    let changed = metadata_call(
        &mut fixture,
        "filesystem.metadata.chmod",
        &["file"],
        request,
        Value::Null,
        false,
    );
    assert_eq!(changed["value"], json!({}));
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let readback = metadata_call(
        &mut fixture,
        "filesystem.metadata.chmod",
        &["file"],
        json!({"path":path,"mode":0o640,"readback":true}),
        Value::Null,
        true,
    );
    assert_eq!(readback["ok"], true, "{readback}");
    assert_eq!(readback["value"]["kind"], "file");
    assert_eq!(readback["value"]["mode"].as_u64().unwrap() & 0o777, 0o640);
    assert_eq!(
        readback["value"]["mode"].as_u64().unwrap() & libc::S_IFMT as u64,
        libc::S_IFREG as u64
    );
    assert!(readback["value"]["mtimeNs"].is_string());
    fixture.constraints["roots"][0]["rights"] = json!(["read"]);
    let stat = metadata_call(
        &mut fixture,
        "filesystem.metadata.stat",
        &["file"],
        json!({"path":path}),
        Value::Null,
        false,
    );
    assert_eq!(stat["ok"], true, "{stat}");
    assert_eq!(stat["value"]["mode"], readback["value"]["mode"]);
}

#[test]
fn readonly_file_and_directory_bindings_chmod_the_original_inode() {
    use std::os::unix::fs::PermissionsExt;
    let mut fixture = Fixture::with_chmod("deny");
    let file = fixture.path.join("file");
    fs::write(&file, b"ORIGINAL").unwrap();
    let opened = metadata_call(
        &mut fixture,
        "filesystem.file.open",
        &["file"],
        json!({"flag":"r"}),
        Value::Null,
        false,
    );
    assert_eq!(opened["ok"], true, "{opened}");
    let binding = opened["value"]["bindingId"].clone();
    fs::rename(&file, fixture.path.join("held")).unwrap();
    fs::write(&file, b"REPLACEMENT").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    fixture.constraints["roots"][0]["rights"] = json!(["chmod"]);
    let zero = metadata_call(
        &mut fixture,
        "filesystem.metadata.chmod",
        &["file"],
        json!({"mode":0}),
        binding.clone(),
        false,
    );
    assert_eq!(zero["value"], json!({}), "{zero}");
    assert_eq!(
        fs::metadata(fixture.path.join("held"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0
    );
    let restored = metadata_call(
        &mut fixture,
        "filesystem.metadata.chmod",
        &["file"],
        json!({"mode":0o644,"readback":true}),
        binding,
        true,
    );
    assert_eq!(restored["ok"], true, "{restored}");
    assert_eq!(restored["value"]["mode"].as_u64().unwrap() & 0o777, 0o644);
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let directory = fixture.path.join("directory");
    fs::create_dir(&directory).unwrap();
    fixture.constraints["roots"][0]["rights"] = json!(["list", "chmod"]);
    let opened = metadata_call(
        &mut fixture,
        "filesystem.directory.open",
        &["directory"],
        json!({"path":"holo-fs://workspace/directory"}),
        Value::Null,
        true,
    );
    assert_eq!(opened["ok"], true, "{opened}");
    let binding = opened["value"]["bindingId"].clone();
    fs::rename(&directory, fixture.path.join("held-directory")).unwrap();
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    fixture.constraints["roots"][0]["rights"] = json!(["chmod"]);
    let changed = metadata_call(
        &mut fixture,
        "filesystem.metadata.chmod",
        &["directory"],
        json!({"mode":0o700,"readback":true}),
        binding,
        true,
    );
    assert_eq!(changed["ok"], true, "{changed}");
    assert_eq!(changed["value"]["kind"], "directory");
    assert_eq!(changed["value"]["mode"].as_u64().unwrap() & 0o777, 0o700);
    assert_eq!(
        fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

#[test]
fn within_root_chmod_consumes_the_verified_pinned_descriptor() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let mut fixture = Fixture::with_chmod("withinRoot");
    fs::create_dir(fixture.path.join("original")).unwrap();
    fs::write(fixture.path.join("original/file"), b"ORIGINAL").unwrap();
    symlink("original/file", fixture.path.join("alias")).unwrap();
    let arguments = json!({"path":"holo-fs://workspace/alias","mode":0o600});
    let prepared = prepare(
        &mut fixture,
        "filesystem.metadata.chmod",
        &["alias"],
        arguments.clone(),
        None,
    );
    assert_eq!(prepared["ok"], true, "{prepared}");
    let ticket = prepared["value"]["ticket"].clone();
    fs::rename(fixture.path.join("original"), fixture.path.join("held")).unwrap();
    fs::create_dir(fixture.path.join("original")).unwrap();
    fs::write(fixture.path.join("original/file"), b"REPLACEMENT").unwrap();
    fs::set_permissions(
        fixture.path.join("original/file"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    let changed = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.metadata.chmod",
        "rootId":"workspace","pathSegments":["original","file"],
        "requestedSegments":["alias"],"resolutionTicket":ticket,
        "arguments":arguments,"constraints":fixture.constraints,"bindingId":null
    }));
    assert_eq!(changed["ok"], true, "{changed}");
    assert_eq!(
        fs::metadata(fixture.path.join("held/file"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_ne!(
        fs::metadata(fixture.path.join("original/file"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn typed_linux_chmod_checks_the_final_descriptor_kind_before_effect() {
    use std::os::unix::fs::PermissionsExt;
    let mut fixture = Fixture::with_chmod("deny");
    let file = fixture.path.join("file");
    let directory = fixture.path.join("directory");
    fs::write(&file, b"DATA").unwrap();
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    let path_request = json!({
        "kind":"invoke","operation":"filesystem.metadata.chmod",
        "rootId":"workspace","pathSegments":["file"],
        "constraints":fixture.constraints,"bindingId":null,
        "arguments":{"path":"holo-fs://workspace/file","mode":0o600,"readback":true,"expectedKind":"directory"},
        "linuxProcess":true
    });
    let wrong_path = fixture.call(&path_request);
    assert_eq!(wrong_path["code"], "resource.invalid", "{wrong_path}");
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o644
    );
    let mut wrong_operation = path_request.clone();
    wrong_operation["operation"] = json!("filesystem.metadata.stat");
    wrong_operation["arguments"] = json!({"path":"holo-fs://workspace/file","expectedKind":"file"});
    assert_eq!(fixture.call(&wrong_operation)["code"], "argument.invalid");

    let mut untrusted = path_request.clone();
    untrusted["linuxProcess"] = json!(false);
    assert_eq!(fixture.call(&untrusted)["code"], "capability.denied");
    untrusted["linuxProcess"] = json!(true);
    untrusted["arguments"]["expectedKind"] = json!("symlink");
    assert_eq!(fixture.call(&untrusted)["code"], "argument.invalid");
    untrusted["arguments"]["expectedKind"] = json!("directory");
    untrusted["arguments"]
        .as_object_mut()
        .unwrap()
        .remove("readback");
    assert_eq!(fixture.call(&untrusted)["code"], "argument.invalid");
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o644
    );

    let mut correct = path_request;
    correct["arguments"]["expectedKind"] = json!("file");
    let changed = fixture.call(&correct);
    assert_eq!(changed["ok"], true, "{changed}");
    assert_eq!(changed["value"]["mode"].as_u64().unwrap() & 0o777, 0o600);

    let opened = metadata_call(
        &mut fixture,
        "filesystem.directory.open",
        &["directory"],
        json!({"path":"holo-fs://workspace/directory"}),
        Value::Null,
        true,
    );
    assert_eq!(opened["ok"], true, "{opened}");
    let wrong_handle = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.metadata.chmod",
        "rootId":"workspace","pathSegments":["directory"],
        "constraints":fixture.constraints,
        "bindingId":opened["value"]["bindingId"],
        "arguments":{"mode":0o700,"readback":true,"expectedKind":"file"},
        "linuxProcess":true
    }));
    assert_eq!(wrong_handle["code"], "resource.invalid", "{wrong_handle}");
    assert_eq!(
        fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

#[test]
fn readonly_file_sync_and_directory_sync_are_real_operations() {
    let mut fixture = Fixture::new();
    fs::write(fixture.path.join("file"), b"data").unwrap();
    let opened = metadata_call(
        &mut fixture,
        "filesystem.file.open",
        &["file"],
        json!({"flag":"r"}),
        Value::Null,
        false,
    );
    assert_eq!(opened["ok"], true);
    let binding = opened["value"]["bindingId"].clone();
    fixture.constraints["roots"][0]["rights"] = json!(["read", "list"]);
    for operation in ["filesystem.file.sync", "filesystem.file.datasync"] {
        let synced = metadata_call(
            &mut fixture,
            operation,
            &["file"],
            json!({}),
            binding.clone(),
            false,
        );
        assert_eq!(synced["ok"], true, "{operation}: {synced}");
    }
    let no_write = metadata_call(
        &mut fixture,
        "filesystem.file.truncate",
        &["file"],
        json!({"len":0}),
        binding,
        false,
    );
    assert_eq!(no_write["code"], "capability.denied");
    assert_eq!(fs::read(fixture.path.join("file")).unwrap(), b"data");

    let opened_dir = metadata_call(
        &mut fixture,
        "filesystem.directory.open",
        &[],
        json!({"path":"holo-fs://workspace/"}),
        Value::Null,
        true,
    );
    assert_eq!(opened_dir["ok"], true, "{opened_dir}");
    assert!(opened_dir["value"]["entries"].is_array());
    let directory_binding = opened_dir["value"]["bindingId"].clone();
    let denied = metadata_call(
        &mut fixture,
        "filesystem.directory.sync",
        &[],
        json!({"dataOnly":false}),
        directory_binding.clone(),
        false,
    );
    assert_eq!(denied["code"], "capability.denied");
    let synced = metadata_call(
        &mut fixture,
        "filesystem.directory.sync",
        &[],
        json!({"dataOnly":false}),
        directory_binding.clone(),
        true,
    );
    assert_eq!(synced["ok"], true, "{synced}");
    let closed = metadata_call(
        &mut fixture,
        "filesystem.directory.close",
        &[],
        json!({}),
        directory_binding.clone(),
        true,
    );
    assert_eq!(closed["ok"], true);
    let stale = metadata_call(
        &mut fixture,
        "filesystem.directory.sync",
        &[],
        json!({"dataOnly":true}),
        directory_binding,
        true,
    );
    assert_eq!(stale["code"], "resource.stale");
}

#[test]
fn directory_handle_syncs_original_inode_after_path_replacement() {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStringExt;
    let mut fixture = Fixture::new();
    fs::create_dir(fixture.path.join("original")).unwrap();
    fs::write(fixture.path.join("original/file"), b"OLD").unwrap();
    fs::create_dir(fixture.path.join("replacement")).unwrap();
    fs::write(fixture.path.join("replacement/file"), b"NEW").unwrap();
    fs::create_dir(fixture.path.join("special")).unwrap();
    let special = fs::File::open(fixture.path.join("special")).unwrap();
    assert_eq!(
        unsafe { libc::mkfifoat(special.as_raw_fd(), c"pipe".as_ptr(), 0o600) },
        0
    );
    fixture.constraints["limits"]["maxOpenHandles"] = json!(1);
    let rejected = metadata_call(
        &mut fixture,
        "filesystem.directory.open",
        &["special"],
        json!({"path":"holo-fs://workspace/special"}),
        Value::Null,
        true,
    );
    assert_eq!(rejected["code"], "provider.unavailable");
    fs::create_dir(fixture.path.join("invalid")).unwrap();
    let invalid_name = std::ffi::OsString::from_vec(vec![b'x', 0xff]);
    match fs::write(fixture.path.join("invalid").join(invalid_name), b"BAD") {
        Ok(()) => {
            let rejected_utf8 = metadata_call(
                &mut fixture,
                "filesystem.directory.open",
                &["invalid"],
                json!({"path":"holo-fs://workspace/invalid"}),
                Value::Null,
                true,
            );
            assert_eq!(rejected_utf8["code"], "provider.unavailable");
        }
        Err(error) if error.raw_os_error() == Some(libc::EILSEQ) => {
            // APFS can reject an invalid name before it reaches the Provider.
            assert!(c"x\xff".to_str().is_err());
        }
        Err(error) => panic!("unexpected invalid-name fixture failure: {error}"),
    }
    let opened = metadata_call(
        &mut fixture,
        "filesystem.directory.open",
        &["original"],
        json!({"path":"holo-fs://workspace/original"}),
        Value::Null,
        true,
    );
    assert_eq!(opened["ok"], true, "{opened}");
    assert_eq!(opened["value"]["entries"][0]["name"], "file");
    let binding = opened["value"]["bindingId"].clone();
    let over_limit = metadata_call(
        &mut fixture,
        "filesystem.file.open",
        &["original", "file"],
        json!({"flag":"r"}),
        Value::Null,
        false,
    );
    assert_eq!(over_limit["code"], "resource.handle_limit");
    fs::rename(fixture.path.join("original"), fixture.path.join("held")).unwrap();
    fs::rename(
        fixture.path.join("replacement"),
        fixture.path.join("original"),
    )
    .unwrap();
    let synced = metadata_call(
        &mut fixture,
        "filesystem.directory.sync",
        &["original"],
        json!({"dataOnly":false}),
        binding.clone(),
        true,
    );
    assert_eq!(synced["ok"], true, "{synced}");
    assert_eq!(fs::read(fixture.path.join("held/file")).unwrap(), b"OLD");
    assert_eq!(
        fs::read(fixture.path.join("original/file")).unwrap(),
        b"NEW"
    );
    let closed = metadata_call(
        &mut fixture,
        "filesystem.directory.close",
        &["original"],
        json!({}),
        binding,
        true,
    );
    assert_eq!(closed["ok"], true);
    let after_close = metadata_call(
        &mut fixture,
        "filesystem.file.open",
        &["held", "file"],
        json!({"flag":"r"}),
        Value::Null,
        false,
    );
    assert_eq!(after_close["ok"], true, "{after_close}");
}

#[cfg(target_os = "macos")]
#[test]
fn access_checks_os_permissions_and_rejects_regular_file_execution() {
    use std::os::unix::fs::PermissionsExt;
    let mut fixture = Fixture::new();
    fs::write(fixture.path.join("file"), b"data").unwrap();
    fs::set_permissions(fixture.path.join("file"), fs::Permissions::from_mode(0o400)).unwrap();
    let path = "holo-fs://workspace/file";
    let readable = metadata_call(
        &mut fixture,
        "filesystem.metadata.access",
        &["file"],
        json!({"path":path,"mode":4}),
        Value::Null,
        false,
    );
    assert_eq!(readable["ok"], true);
    let unwritable = metadata_call(
        &mut fixture,
        "filesystem.metadata.access",
        &["file"],
        json!({"path":path,"mode":2}),
        Value::Null,
        false,
    );
    assert_eq!(unwritable["code"], "provider.permission_denied");
    let no_execute = metadata_call(
        &mut fixture,
        "filesystem.metadata.access",
        &["file"],
        json!({"path":path,"mode":1}),
        Value::Null,
        false,
    );
    assert_eq!(no_execute["code"], "capability.denied");

    fixture.constraints["roots"][0]["rights"] = json!(["list"]);
    let directory_read = metadata_call(
        &mut fixture,
        "filesystem.metadata.access",
        &[],
        json!({"path":"holo-fs://workspace/","mode":4}),
        Value::Null,
        false,
    );
    assert_eq!(directory_read["ok"], true);
    let file_read = metadata_call(
        &mut fixture,
        "filesystem.metadata.access",
        &["file"],
        json!({"path":path,"mode":4}),
        Value::Null,
        false,
    );
    assert_eq!(file_read["code"], "capability.denied");
}

#[cfg(target_os = "macos")]
#[test]
fn path_utimes_preserves_owner_updates_on_write_only_and_read_only_files() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let mut fixture = Fixture::new();
    let file = fixture.path.join("file");
    fs::write(&file, b"UNCHANGED").unwrap();
    for (mode, seconds) in [(0o200, 7000), (0o400, 8000)] {
        fs::set_permissions(&file, fs::Permissions::from_mode(mode)).unwrap();
        let changed = metadata_call(
            &mut fixture,
            "filesystem.metadata.utimes",
            &["file"],
            json!({
                "path":"holo-fs://workspace/file",
                "atime":{"kind":"set","seconds":seconds,"nanoseconds":0},
                "mtime":{"kind":"set","seconds":seconds,"nanoseconds":123000000}
            }),
            Value::Null,
            false,
        );
        assert_eq!(changed["ok"], true, "mode {mode:o}: {changed}");
        assert_eq!(fs::metadata(&file).unwrap().mtime(), seconds);
    }
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(fs::read(&file).unwrap(), b"UNCHANGED");
}

#[test]
fn within_root_utimes_uses_the_ticket_pinned_file_after_path_replacement() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::with_profile("withinRoot");
    let outside = Fixture::new();
    fs::create_dir(fixture.path.join("original")).unwrap();
    fs::write(fixture.path.join("original/file"), b"ORIGINAL").unwrap();
    fs::write(outside.path.join("file"), b"OUTSIDE").unwrap();
    symlink("original/file", fixture.path.join("alias")).unwrap();
    let arguments = json!({
        "path":"holo-fs://workspace/alias",
        "atime":{"kind":"omit"},
        "mtime":{"kind":"set","seconds":1700000000,"nanoseconds":654321987},
        "readback":true
    });
    let prepared = fixture.call(&json!({
        "kind":"prepareResolution","operation":"filesystem.metadata.utimes",
        "rootId":"workspace","pathSegments":["alias"],
        "arguments":arguments,"constraints":fixture.constraints,"linuxProcess":true
    }));
    assert_eq!(prepared["ok"], true, "{prepared}");
    let ticket = prepared["value"]["ticket"].clone();
    let verified = fixture.call(&json!({
        "kind":"verifyResolution","rootId":"workspace","ticket":ticket
    }));
    assert_eq!(verified["ok"], true, "{verified}");

    fs::rename(fixture.path.join("original"), fixture.path.join("held")).unwrap();
    symlink(&outside.path, fixture.path.join("original")).unwrap();
    fs::remove_file(fixture.path.join("alias")).unwrap();
    symlink(outside.path.join("file"), fixture.path.join("alias")).unwrap();
    let changed = fixture.call(&json!({
        "kind":"invoke","operation":"filesystem.metadata.utimes",
        "rootId":"workspace","pathSegments":["original","file"],
        "requestedSegments":["alias"],"resolutionTicket":ticket,
        "arguments":arguments,"constraints":fixture.constraints,
        "bindingId":null,"linuxProcess":true
    }));
    assert_eq!(changed["ok"], true, "{changed}");
    assert_eq!(changed["value"]["mtimeNs"], "1700000000654321987");
    use std::os::unix::fs::MetadataExt;
    assert_eq!(
        fs::metadata(fixture.path.join("held/file"))
            .unwrap()
            .mtime(),
        1700000000
    );
    assert_ne!(
        fs::metadata(outside.path.join("file")).unwrap().mtime(),
        1700000000
    );
}

#[test]
fn within_root_lstat_pins_regular_files_directories_and_parent_aliases() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::with_profile("withinRoot");
    fs::create_dir(fixture.path.join("real")).unwrap();
    fs::write(fixture.path.join("real/file"), b"ORIGINAL").unwrap();
    symlink("real", fixture.path.join("alias")).unwrap();
    for (requested, resolved, kind) in [
        (vec!["real", "file"], vec!["real", "file"], "file"),
        (vec!["real"], vec!["real"], "directory"),
        (vec!["alias", "file"], vec!["real", "file"], "file"),
        (vec![], vec![], "directory"),
    ] {
        let prepared = prepare(
            &mut fixture,
            "filesystem.metadata.lstat",
            &requested,
            json!({}),
            None,
        );
        assert_eq!(prepared["ok"], true, "{prepared}");
        assert_eq!(prepared["value"]["resolvedSegments"], json!(resolved));
        let request = json!({
            "kind":"invoke", "operation":"filesystem.metadata.lstat",
            "rootId":"workspace", "pathSegments":resolved, "requestedSegments":requested,
            "resolutionTicket":prepared["value"]["ticket"],
            "constraints":fixture.constraints, "bindingId":null, "arguments":{}
        });
        let result = fixture.call(&request);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["value"]["kind"], kind);
        if kind == "file" {
            assert_eq!(result["value"]["size"], 8);
        }
        assert_eq!(fixture.call(&request)["code"], "resource.stale");
    }
}

#[test]
fn within_root_lstat_rejects_final_links_missing_special_objects_and_prefix_escape() {
    use std::{ffi::CString, os::unix::fs::symlink};
    let mut fixture = Fixture::with_profile("withinRoot");
    fs::create_dir(fixture.path.join("allowed")).unwrap();
    fs::create_dir(fixture.path.join("outside-prefix")).unwrap();
    fs::write(fixture.path.join("outside-prefix/file"), b"SECRET").unwrap();
    symlink("../outside-prefix", fixture.path.join("allowed/alias")).unwrap();
    for (name, target) in [
        ("in-root", "outside-prefix/file"),
        ("external", "/etc/passwd"),
        ("broken", "absent"),
        ("dir-link", "allowed"),
    ] {
        symlink(target, fixture.path.join(name)).unwrap();
        let result = prepare(
            &mut fixture,
            "filesystem.metadata.lstat",
            &[name],
            json!({}),
            None,
        );
        assert_eq!(result, json!({"ok":false,"code":"provider.unavailable"}));
    }
    let fifo = CString::new(fixture.path.join("fifo").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert_eq!(
        prepare(
            &mut fixture,
            "filesystem.metadata.lstat",
            &["fifo"],
            json!({}),
            None
        )["code"],
        "provider.unavailable"
    );
    assert_eq!(
        prepare(
            &mut fixture,
            "filesystem.metadata.lstat",
            &["absent"],
            json!({}),
            None
        )["code"],
        "resource.not_found"
    );
    let mut constraints = fixture.constraints.clone();
    constraints["roots"][0]["pathPrefixSegments"] = json!(["allowed"]);
    assert_eq!(
        prepare(
            &mut fixture,
            "filesystem.metadata.lstat",
            &["outside-prefix", "file"],
            json!({}),
            Some(constraints.clone())
        )["code"],
        "capability.denied"
    );
    let prepared = prepare(
        &mut fixture,
        "filesystem.metadata.lstat",
        &["allowed", "alias", "file"],
        json!({}),
        Some(constraints.clone()),
    );
    assert_eq!(prepared["ok"], true, "{prepared}");
    assert_eq!(
        prepared["value"]["resolvedSegments"],
        json!(["outside-prefix", "file"])
    );
    let denied = fixture.call(&json!({
        "kind":"invoke", "operation":"filesystem.metadata.lstat", "rootId":"workspace",
        "pathSegments":["outside-prefix", "file"], "requestedSegments":["allowed", "alias", "file"],
        "resolutionTicket":prepared["value"]["ticket"], "constraints":constraints,
        "bindingId":null, "arguments":{}
    }));
    assert_eq!(denied["code"], "capability.denied");
    fixture.call(&json!({"kind":"closeResolution","ticket":prepared["value"]["ticket"]}));
}

#[test]
fn within_root_lstat_rejects_preverify_replacement_and_closes_cancelled_tickets() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::with_profile("withinRoot");
    for replacement_is_link in [false, true] {
        fs::write(fixture.path.join("file"), b"OLD").unwrap();
        let prepared = fixture.call(&json!({
            "kind":"prepareResolution", "operation":"filesystem.metadata.lstat",
            "rootId":"workspace", "pathSegments":["file"], "arguments":{}, "constraints":fixture.constraints
        }));
        assert_eq!(prepared["ok"], true, "{prepared}");
        fs::rename(fixture.path.join("file"), fixture.path.join("old")).unwrap();
        if replacement_is_link {
            symlink("old", fixture.path.join("file")).unwrap();
        } else {
            fs::write(fixture.path.join("file"), b"REPLACEMENT").unwrap();
        }
        let ticket = prepared["value"]["ticket"].clone();
        assert_eq!(
            fixture.call(&json!({"kind":"verifyResolution","rootId":"workspace","ticket":ticket}))
                ["code"],
            "resource.stale"
        );
        assert_eq!(
            fixture.call(&json!({"kind":"closeResolution","ticket":ticket}))["ok"],
            true
        );
        assert_eq!(
            fixture.call(&json!({"kind":"verifyResolution","rootId":"workspace","ticket":ticket}))
                ["code"],
            "resource.stale"
        );
        fs::remove_file(fixture.path.join("file")).unwrap();
        fs::remove_file(fixture.path.join("old")).unwrap();
    }
    fs::write(fixture.path.join("file"), b"CANCEL").unwrap();
    let prepared = prepare(
        &mut fixture,
        "filesystem.metadata.lstat",
        &["file"],
        json!({}),
        None,
    );
    let ticket = prepared["value"]["ticket"].clone();
    fixture.call(&json!({"kind":"closeResolution","ticket":ticket}));
    assert_eq!(
        fixture.call(&json!({
            "kind":"invoke", "operation":"filesystem.metadata.lstat", "rootId":"workspace",
            "pathSegments":["file"], "requestedSegments":["file"], "resolutionTicket":ticket,
            "constraints":fixture.constraints, "bindingId":null, "arguments":{}
        }))["code"],
        "resource.stale"
    );
}

#[test]
fn within_root_lstat_reads_only_the_verified_object_after_namespace_replacement() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::with_profile("withinRoot");
    fs::create_dir(fixture.path.join("real")).unwrap();
    fs::write(fixture.path.join("real/file"), b"ORIGINAL").unwrap();
    symlink("real", fixture.path.join("alias")).unwrap();
    let prepared = prepare(
        &mut fixture,
        "filesystem.metadata.lstat",
        &["alias", "file"],
        json!({}),
        None,
    );
    assert_eq!(prepared["ok"], true, "{prepared}");
    fs::rename(fixture.path.join("real"), fixture.path.join("moved")).unwrap();
    fs::create_dir(fixture.path.join("real")).unwrap();
    fs::write(fixture.path.join("real/file"), b"UNAUTHORIZED REPLACEMENT").unwrap();
    fs::remove_file(fixture.path.join("alias")).unwrap();
    symlink("/etc", fixture.path.join("alias")).unwrap();
    let result = fixture.call(&json!({
        "kind":"invoke", "operation":"filesystem.metadata.lstat", "rootId":"workspace",
        "pathSegments":["real", "file"], "requestedSegments":["alias", "file"],
        "resolutionTicket":prepared["value"]["ticket"], "constraints":fixture.constraints,
        "bindingId":null, "arguments":{}
    }));
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["value"]["kind"], "file");
    assert_eq!(result["value"]["size"], 8);
    assert_eq!(
        fs::read(fixture.path.join("moved/file")).unwrap(),
        b"ORIGINAL"
    );
    assert_eq!(
        fs::read(fixture.path.join("real/file")).unwrap(),
        b"UNAUTHORIZED REPLACEMENT"
    );
}

#[test]
fn deny_lstat_keeps_final_link_metadata_and_denies_parent_aliases() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::new();
    fs::create_dir(fixture.path.join("real")).unwrap();
    fs::write(fixture.path.join("real/file"), b"FILE").unwrap();
    symlink("real", fixture.path.join("alias")).unwrap();
    symlink("absent", fixture.path.join("broken")).unwrap();
    for (path, kind) in [
        (vec!["real", "file"], "file"),
        (vec!["real"], "directory"),
        (vec!["broken"], "symlink"),
    ] {
        let result = metadata_call(
            &mut fixture,
            "filesystem.metadata.lstat",
            &path,
            json!({}),
            Value::Null,
            false,
        );
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["value"]["kind"], kind);
    }
    let result = metadata_call(
        &mut fixture,
        "filesystem.metadata.lstat",
        &["alias", "file"],
        json!({}),
        Value::Null,
        false,
    );
    assert_eq!(result["code"], "resource.cross_root");
}
