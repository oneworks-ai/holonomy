use holonomy_desktop_host::{HostConfiguration, RuntimeLaunch};
use serde_json::{Value, json};
use std::io::Cursor;

fn launch() -> Value {
    json!({"schemaVersion":1,"generation":1,"entry":"/workspace/index.js","argv":["argument"],"timeout":1000,"testMode":false,"hostConfig":null})
}

#[test]
fn device_provider_requires_exact_explicit_host_selection() {
    let base = json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2}});
    let absent: HostConfiguration = serde_json::from_value(base.clone()).unwrap();
    assert!(absent.device_provider.is_none());
    assert!(absent.validate().is_ok());

    let mut selected = base.clone();
    selected["deviceProvider"] = json!({"implementation":"builtin.darwin-device-v1"});
    let selected_config: HostConfiguration = serde_json::from_value(selected.clone()).unwrap();
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    assert!(selected_config.validate().is_ok());
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    assert!(selected_config.validate().is_err());

    selected["deviceProvider"]["implementation"] = json!("third-party.device-v1");
    let unknown: HostConfiguration = serde_json::from_value(selected.clone()).unwrap();
    assert!(unknown.validate().is_err());
    selected["deviceProvider"]["implementation"] = json!("builtin.darwin-device-v1");
    selected["deviceProvider"]["sourceOverride"] = json!("fixture");
    assert!(serde_json::from_value::<HostConfiguration>(selected).is_err());
}
fn parse(value: &Value) -> Result<RuntimeLaunch, String> {
    RuntimeLaunch::read(Cursor::new(format!("{value}\n")))
}

#[cfg(unix)]
#[test]
fn service_private_process_manifest_installs_after_host_reload() {
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        time::{SystemTime, UNIX_EPOCH},
    };
    let root = std::env::temp_dir().join(format!(
        "holo-process-launch-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let host = root.join("host.json");
    let manifest = root.join("process-profiles.json");
    fs::write(&host, json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"processProfileId":"developer"}).to_string()).unwrap();
    fs::write(&manifest, json!({"schemaVersion":1,"profiles":{"developer":{"profile":"process-profile-v1","backend":{"backendId":"native.darwin-seatbelt-v1"}}}}).to_string()).unwrap();
    fs::set_permissions(&manifest, fs::Permissions::from_mode(0o600)).unwrap();
    let mut input = launch();
    input["testMode"] = json!(true);
    input["hostConfig"] = json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2}});
    input["servicePluginConfig"] = json!(host);
    input["servicePluginRevision"] = json!(1);
    input["processProfilesManifest"] = json!(manifest);
    let selected = parse(&input).unwrap();
    assert_eq!(
        selected
            .host_config
            .as_ref()
            .unwrap()
            .process_profile
            .as_ref()
            .unwrap()["backend"]["backendId"],
        "native.darwin-seatbelt-v1"
    );
    input
        .as_object_mut()
        .unwrap()
        .remove("processProfilesManifest");
    assert!(parse(&input).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn private_launch_rejects_unknown_versions_keys_and_invalid_bounds() {
    assert!(parse(&launch()).is_ok());
    for (key, value) in [
        ("schemaVersion", json!(2)),
        ("generation", json!(0)),
        ("generation", json!(2)),
        ("timeout", json!(0)),
        ("timeout", json!(-1)),
        ("timeout", json!(1.5)),
        ("timeout", json!(86400001)),
        ("entry", json!("relative.js")),
        ("nativeFd", json!(3)),
        ("argv", json!([1])),
    ] {
        let mut input = launch();
        input[key] = value;
        assert!(parse(&input).is_err(), "accepted {input}");
    }
    let mut input = launch();
    input["argv"] = json!(vec!["argument"; 257]);
    assert!(parse(&input).is_err());
    assert!(RuntimeLaunch::read(Cursor::new(launch().to_string())).is_err());
}

#[test]
fn private_launch_v3_requires_workspace_allowlist_and_bounded_aliases() {
    let mut v2 = launch();
    v2["schemaVersion"] = json!(2);
    v2["workspaceRoot"] = json!("/workspace");
    assert!(parse(&v2).is_ok());
    let alias = json!({"url":"app://workspace/node_modules/pkg/index.mjs", "canonicalUrl":"app://workspace/node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs"});
    let mut v3 = v2.clone();
    v3["schemaVersion"] = json!(3);
    v3["moduleAllowlist"] = json!([
        "app://workspace/index.js",
        alias["url"],
        alias["canonicalUrl"]
    ]);
    v3["moduleAliases"] = json!([alias]);
    assert_eq!(parse(&v3).unwrap().module_aliases.unwrap().len(), 1);
    let mut invalid = v2.clone();
    invalid["moduleAliases"] = v3["moduleAliases"].clone();
    assert!(parse(&invalid).is_err());
    invalid = launch();
    invalid["moduleAliases"] = v3["moduleAliases"].clone();
    assert!(parse(&invalid).is_err());
    for field in ["workspaceRoot", "moduleAllowlist", "moduleAliases"] {
        let mut invalid = v3.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(parse(&invalid).is_err(), "accepted absent {field}");
    }
    let mut invalid = v3.clone();
    invalid["moduleAliases"][0]["extra"] = json!(true);
    assert!(parse(&invalid).is_err());
    let mut invalid = v3;
    invalid["moduleAllowlist"] = json!(vec!["app://workspace/module.mjs"; 1025]);
    assert!(parse(&invalid).is_err());
}

#[test]
fn private_launch_v4_requires_exact_package_metadata_urls() {
    let mut v4 = launch();
    v4["schemaVersion"] = json!(4);
    v4["workspaceRoot"] = json!("/workspace");
    v4["moduleAllowlist"] = json!(["app://workspace/index.js", "app://workspace/package.json"]);
    v4["moduleMetadataOnly"] = json!(["app://workspace/package.json"]);
    assert_eq!(parse(&v4).unwrap().module_metadata_only.len(), 1);
    let mut with_alias = v4.clone();
    with_alias["moduleAllowlist"] = json!([
        "app://workspace/index.js",
        "app://workspace/package.json",
        "app://workspace/alias/package.json"
    ]);
    with_alias["moduleAliases"] = json!([{
        "url":"app://workspace/alias/package.json",
        "canonicalUrl":"app://workspace/package.json"
    }]);
    assert_eq!(parse(&with_alias).unwrap().module_aliases.unwrap().len(), 1);
    let mut v2 = v4.clone();
    v2["schemaVersion"] = json!(2);
    assert!(parse(&v2).is_err(), "accepted V2 metadata flags");
    let mut v3 = with_alias.clone();
    v3["schemaVersion"] = json!(3);
    assert!(parse(&v3).is_err(), "accepted V3 metadata flags");
    let mut v1 = launch();
    v1["moduleMetadataOnly"] = json!(["app://workspace/package.json"]);
    assert!(parse(&v1).is_err());
    for value in [
        json!([]),
        json!(["app://workspace/package.json?revision=1"]),
        json!(["app://workspace/config.json"]),
        json!([
            "app://workspace/package.json",
            "app://workspace/package.json"
        ]),
    ] {
        let mut invalid = v4.clone();
        invalid["moduleMetadataOnly"] = value;
        assert!(parse(&invalid).is_err(), "accepted {invalid}");
    }
}

#[test]
fn private_launch_rejects_ambiguous_root_installations_and_unknown_host_config() {
    let mut input = launch();
    input["hostConfig"] = json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"filesystemRoots":[{"rootId":"one","hostPath":"/workspace"},{"rootId":"one","hostPath":"/elsewhere"}]});
    assert!(parse(&input).is_err());
    input["hostConfig"] = json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"nativePlugin":"unregistered"});
    assert!(parse(&input).is_err());

    input["hostConfig"] = json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"engineGate":{"strings":"allow"}});
    assert!(parse(&input).is_err());
}

#[test]
fn diagnostic_audit_has_strict_installation_bounds_and_no_public_ready_flag() {
    for audit in [
        json!({"path":"/private/audit.jsonl","maxBytes":1023}),
        json!({"path":"/private/audit.jsonl","maxBytes":16777217}),
        json!({"path":"/private/audit.jsonl","maxBytes":1.5}),
        json!({"path":"relative.jsonl","maxBytes":1024}),
        json!({"path":"/private/audit.jsonl","maxBytes":1024,"extra":true}),
    ] {
        let mut input = launch();
        input["hostConfig"] =
            json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"diagnosticAudit":audit});
        assert!(parse(&input).is_err(), "accepted {input}");
    }
    let mut input = launch();
    input["hostConfig"] =
        json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},"diagnosticAuditReady":true});
    assert!(parse(&input).is_err());
}

#[cfg(unix)]
#[test]
fn process_profile_is_selected_from_owner_only_manifest_before_private_launch() {
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
        time::{SystemTime, UNIX_EPOCH},
    };
    let root = std::env::temp_dir().join(format!(
        "holo-process-profile-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let config_path = root.join("host.json");
    fs::write(
        &config_path,
        json!({
            "schemaVersion": 1,
            "sandboxPolicy": {"schemaVersion": 2},
            "processProfileId": "developer"
        })
        .to_string(),
    )
    .unwrap();
    let manifest_path = root.join("process-profiles.json");
    fs::write(
        &manifest_path,
        json!({
            "schemaVersion": 1,
            "profiles": {"developer": {"profile": "process-profile-v1", "executables": []}}
        })
        .to_string(),
    )
    .unwrap();
    fs::set_permissions(&manifest_path, fs::Permissions::from_mode(0o600)).unwrap();
    let linked = root.join("linked-profiles.json");
    symlink(&manifest_path, &linked).unwrap();

    let mut config = HostConfiguration::read(&config_path).unwrap();
    assert!(config.install_process_profile(&linked).is_err());
    let mut launch = launch();
    launch["hostConfig"] = serde_json::to_value(&config).unwrap();
    assert!(
        parse(&launch).is_err(),
        "selected profile without installation was admitted"
    );
    config.install_process_profile(&manifest_path).unwrap();
    launch["hostConfig"] = serde_json::to_value(&config).unwrap();
    let admitted = parse(&launch).unwrap();
    assert_eq!(
        admitted.host_config.unwrap().process_profile.unwrap()["profile"],
        "process-profile-v1"
    );

    fs::set_permissions(&manifest_path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        HostConfiguration::read(&config_path)
            .unwrap()
            .install_process_profile(&manifest_path)
            .is_err()
    );
    fs::write(
        &config_path,
        json!({
            "schemaVersion": 1,
            "sandboxPolicy": {"schemaVersion": 2},
            "processProfileId": "developer",
            "processProfile": {"profile": "forged"}
        })
        .to_string(),
    )
    .unwrap();
    assert!(HostConfiguration::read(&config_path).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn v86_backend_installation_requires_separate_owner_manifest() {
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        time::{SystemTime, UNIX_EPOCH},
    };
    let root = std::env::temp_dir().join(format!(
        "holo-v86-install-selection-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    fs::create_dir(root.join("assets")).unwrap();
    let config_path = root.join("host.json");
    fs::write(
        &config_path,
        json!({
            "schemaVersion":1,
            "sandboxPolicy":{"schemaVersion":2},
            "processProfileId":"linux"
        })
        .to_string(),
    )
    .unwrap();
    let profile_path = root.join("process-profiles.json");
    fs::write(&profile_path, json!({
        "schemaVersion":1,
        "profiles":{"linux":{"profile":"process-profile-v1","backend":{"backendId":"experimental.v86-v1"}}}
    }).to_string()).unwrap();
    fs::set_permissions(&profile_path, fs::Permissions::from_mode(0o600)).unwrap();
    let backend_path = root.join("process-backends.json");
    fs::write(&backend_path, json!({
        "schemaVersion":1,
        "backends":{"experimental.v86-v1":{"implementation":"builtin.v86-v1","artifactRoot":root.join("assets")}}
    }).to_string()).unwrap();
    fs::set_permissions(&backend_path, fs::Permissions::from_mode(0o600)).unwrap();

    let mut config = HostConfiguration::read(&config_path).unwrap();
    config.install_process_profile(&profile_path).unwrap();
    let mut input = launch();
    input["hostConfig"] = serde_json::to_value(&config).unwrap();
    assert!(
        parse(&input).is_err(),
        "v86 profile without installation was admitted"
    );
    config.install_process_backend(&backend_path).unwrap();
    input["hostConfig"] = serde_json::to_value(&config).unwrap();
    let selected = parse(&input).unwrap().host_config.unwrap();
    assert_eq!(
        selected.process_backend_installation.unwrap()["backendId"],
        "experimental.v86-v1"
    );
    assert_eq!(selected.private_sources.len(), 3);

    fs::set_permissions(&backend_path, fs::Permissions::from_mode(0o644)).unwrap();
    let mut unsafe_config = HostConfiguration::read(&config_path).unwrap();
    unsafe_config
        .install_process_profile(&profile_path)
        .unwrap();
    assert!(
        unsafe_config
            .install_process_backend(&backend_path)
            .is_err()
    );
    fs::write(
        &config_path,
        json!({
            "schemaVersion":1,
            "sandboxPolicy":{"schemaVersion":2},
            "processProfileId":"linux",
            "processBackendInstallation":{"artifactRoot":root.join("assets")}
        })
        .to_string(),
    )
    .unwrap();
    assert!(HostConfiguration::read(&config_path).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn host_plugin_config_resolves_relative_package_and_explicitly_allowed_absolute_sources() {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };
    let root = std::env::temp_dir().join(format!(
        "holo-host-plugin-config-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    fs::create_dir(root.join("plugins")).unwrap();
    fs::create_dir_all(root.join("node_modules/@fixture/example")).unwrap();
    fs::write(
        root.join("plugins/relative.mjs"),
        "export default () => {};",
    )
    .unwrap();
    fs::write(
        root.join("plugins/absolute.mjs"),
        "export default () => {};",
    )
    .unwrap();
    fs::write(
        root.join("node_modules/@fixture/example/package.json"),
        r#"{"holo":{"apiVersion":1,"entry":"./index.mjs","kind":"runtime-plugin"}}"#,
    )
    .unwrap();
    fs::write(
        root.join("node_modules/@fixture/example/index.mjs"),
        "export default () => {};",
    )
    .unwrap();
    let absolute = root.join("plugins/absolute.mjs");
    let config_path = root.join("host.json");
    fs::write(
        &config_path,
        json!({
            "schemaVersion": 1,
            "sandboxPolicy": {"schemaVersion": 2},
            "pluginRoots": ["./plugins"],
            "plugins": [
                {"id":"relative","use":"./plugins/relative.mjs"},
                {"id":"package","use":"@fixture/example"},
                {"id":"absolute","use":absolute}
            ]
        })
        .to_string(),
    )
    .unwrap();
    let mut config = HostConfiguration::read(&config_path).unwrap();
    assert_eq!(config.runtime_plugins.len(), 3);
    assert_eq!(
        config.runtime_plugins[1].entry_url,
        "holo-plugins:///package/index.mjs"
    );
    assert!(
        config
            .plugin_sources
            .read("holo-plugins:///relative/relative.mjs")
            .unwrap()
            .is_some()
    );
    assert!(
        config
            .plugin_sources
            .read("holo-plugins:///package/index.mjs")
            .unwrap()
            .is_some()
    );
    assert!(
        config
            .plugin_sources
            .read("holo-plugins:///absolute/absolute.mjs")
            .unwrap()
            .is_some()
    );
    for field in ["runtimePlugins", "runtimePluginRoots"] {
        let mut public = json!({"schemaVersion":1,"sandboxPolicy":{"schemaVersion":2}});
        public[field] = json!([]);
        fs::write(&config_path, public.to_string()).unwrap();
        assert!(HostConfiguration::read(&config_path).is_err());
    }
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn private_plugin_root_handoff_rejects_replacement_symlink_and_ancestor_rebinding() {
    use std::{
        fs,
        os::unix::fs::symlink,
        time::{SystemTime, UNIX_EPOCH},
    };
    let root = std::env::temp_dir().join(format!(
        "holo-plugin-root-identity-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let setup = |name: &str| {
        let fixture = root.join(name);
        fs::create_dir(&fixture).unwrap();
        fs::create_dir(fixture.join("plugins")).unwrap();
        fs::write(
            fixture.join("plugins/plugin.mjs"),
            "export default () => {};",
        )
        .unwrap();
        fs::write(fixture.join("entry.mjs"), "console.log('entry');").unwrap();
        let config_path = fixture.join("host.json");
        fs::write(
            &config_path,
            json!({
                "schemaVersion": 1,
                "sandboxPolicy": {"schemaVersion": 2},
                "plugins": [{"id":"plugin","use":"./plugins/plugin.mjs"}]
            })
            .to_string(),
        )
        .unwrap();
        let config = HostConfiguration::read(&config_path).unwrap();
        let launch = RuntimeLaunch {
            workspace_root: None,
            module_allowlist: None,
            module_aliases: None,
            module_metadata_only: vec![],
            argv: vec![],
            entry: fixture.join("entry.mjs").canonicalize().unwrap(),
            generation: 1,
            host_config: Some(config),
            watch_config: None,
            service_plugin_config: None,
            process_profiles_manifest: None,
            service_plugin_revision: None,
            inspector_socket: None,
            inspector_wait_for_debugger: false,
            schema_version: 1,
            test_mode: false,
            timeout: Some(1000),
        };
        (fixture, launch.encode().unwrap())
    };

    let parse = |payload: &str| RuntimeLaunch::read(Cursor::new(format!("{payload}\n")));

    let (replacement, replacement_payload) = setup("replacement");
    assert!(
        parse(&replacement_payload).is_ok(),
        "unchanged root must rehydrate"
    );
    fs::rename(replacement.join("plugins"), replacement.join("retired")).unwrap();
    fs::create_dir(replacement.join("plugins")).unwrap();
    fs::write(
        replacement.join("plugins/plugin.mjs"),
        "export default () => {};",
    )
    .unwrap();
    assert!(
        parse(&replacement_payload).is_err(),
        "same-name replacement was accepted"
    );

    let (linked, linked_payload) = setup("linked");
    fs::rename(linked.join("plugins"), linked.join("retired")).unwrap();
    symlink(linked.join("retired"), linked.join("plugins")).unwrap();
    assert!(
        parse(&linked_payload).is_err(),
        "symlinked root was accepted"
    );

    let (ancestor, ancestor_payload) = setup("ancestor");
    let parent = ancestor.parent().unwrap().to_path_buf();
    let retired = root.join("ancestor-retired");
    fs::rename(&ancestor, &retired).unwrap();
    fs::create_dir(&ancestor).unwrap();
    fs::create_dir(ancestor.join("plugins")).unwrap();
    fs::write(
        ancestor.join("plugins/plugin.mjs"),
        "export default () => {};",
    )
    .unwrap();
    assert_eq!(parent, root);
    assert!(
        parse(&ancestor_payload).is_err(),
        "ancestor replacement was accepted"
    );
    fs::remove_dir_all(root).unwrap();
}
