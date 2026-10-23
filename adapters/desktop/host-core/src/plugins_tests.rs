use super::*;

#[test]
fn standalone_resource_graph_keeps_the_restored_package_directory() {
    let parent = std::env::temp_dir().join(format!(
        "holo-restored-package-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let package = parent.join("node_modules/pkg");
    fs::create_dir_all(&package).unwrap();
    fs::write(package.join("package.json"), r#"{"name":"pkg","type":"module","holo":{"apiVersion":1,"kind":"runtime-plugin","entry":"./index.mjs","configSchema":"./schema.json"}}"#).unwrap();
    fs::write(package.join("schema.json"), r#"{"const":"OLD_SCHEMA"}"#).unwrap();
    let original = "import 'dep'; export default () => 'OLD_MODULE';";
    fs::write(package.join("index.mjs"), original).unwrap();
    fs::create_dir_all(package.join("node_modules/dep")).unwrap();
    fs::write(
        package.join("node_modules/dep/package.json"),
        r#"{"name":"dep","type":"module","stamp":"OLD_DEP"}"#,
    )
    .unwrap();
    fs::write(
        package.join("node_modules/dep/index.mjs"),
        "export default 'OLD_DEP';",
    )
    .unwrap();
    let root = parent.canonicalize().unwrap();
    let prepared = prepare_native_plugins(
        &[HostPluginInstallation {
            config: json!("OLD_SCHEMA"),
            enabled: true,
            export_name: "default".into(),
            id: "plugin".into(),
            integrity: None,
            source: "pkg".into(),
            source_graph: None,
        }],
        &[],
        &root,
    )
    .unwrap();
    assert_eq!(
        prepared.installations[0].config_schema,
        Some(json!({"const":"OLD_SCHEMA"}))
    );
    let mut restored = NativePluginSources::from_roots(&prepared.roots).unwrap();
    restored.install_resource_roots(&prepared.roots).unwrap();
    restored
        .read(&prepared.installations[0].entry_url)
        .unwrap()
        .unwrap();
    fs::rename(&package, parent.join("old-package")).unwrap();
    fs::create_dir(&package).unwrap();
    fs::write(package.join("package.json"), r#"{"name":"pkg","type":"module","holo":{"apiVersion":1,"kind":"runtime-plugin","entry":"./index.mjs"}}"#).unwrap();
    fs::write(
        package.join("index.mjs"),
        "export default () => 'NEW_MODULE';",
    )
    .unwrap();
    fs::create_dir_all(package.join("node_modules/dep")).unwrap();
    fs::write(
        package.join("node_modules/dep/package.json"),
        r#"{"name":"dep","type":"module","stamp":"NEW_DEP"}"#,
    )
    .unwrap();
    fs::write(
        package.join("node_modules/dep/index.mjs"),
        "export default 'NEW_DEP';",
    )
    .unwrap();
    let entry = &prepared.installations[0]
        .resource_graph
        .as_ref()
        .unwrap()
        .entry_url;
    if let Ok(Some(value)) = restored.read_resource(entry) {
        let value: Value = serde_json::from_str(&value).unwrap();
        let bytes: Vec<u8> = serde_json::from_value(value["bytes"].clone()).unwrap();
        assert_eq!(String::from_utf8(bytes).unwrap(), original);
    }
    let nested = "holo-plugins:///plugin/node_modules/pkg/node_modules/dep/package.json";
    if let Ok(Some(value)) = restored.read_resource(nested) {
        let value: Value = serde_json::from_str(&value).unwrap();
        let bytes: Vec<u8> = serde_json::from_value(value["bytes"].clone()).unwrap();
        assert!(String::from_utf8(bytes).unwrap().contains("OLD_DEP"));
    }
    let nested = "holo-plugins:///plugin/node_modules/pkg/node_modules/dep/index.mjs";
    if let Ok(Some(value)) = restored.read_resource(nested) {
        let value: Value = serde_json::from_str(&value).unwrap();
        let bytes: Vec<u8> = serde_json::from_value(value["bytes"].clone()).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "export default 'OLD_DEP';"
        );
    }
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn v2_sidecar_stages_original_manifest_and_one_canonical_dependency() {
    let parent = std::env::temp_dir().join(format!(
        "holo-plugin-v2-sidecar-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let stage = parent.join("plugin-graphs/r1/consumer");
    let sources = stage.join("sources");
    fs::create_dir_all(sources.join("plugins")).unwrap();
    fs::create_dir_all(sources.join("node_modules/.pnpm/tiny@1/node_modules/tiny")).unwrap();
    let entry = "import {value} from 'tiny'; export default () => value;";
    let manifest = r#"{"name":"tiny","type":"module","exports":{".":"./index.mjs"}}"#;
    let dependency = "export const value = 1;";
    let files = [
        ("plugins/consumer.mjs", entry),
        (
            "node_modules/.pnpm/tiny@1/node_modules/tiny/package.json",
            manifest,
        ),
        (
            "node_modules/.pnpm/tiny@1/node_modules/tiny/index.mjs",
            dependency,
        ),
    ];
    let root_url = "holo-plugins:///consumer/";
    let mut reads = Vec::new();
    for (relative, text) in files {
        let path = sources.join(relative);
        fs::write(&path, text).unwrap();
        reads.push(json!({
            "url": format!("{root_url}{relative}"),
            "byteLength": text.len(),
            "sha256": format!("{:x}", Sha256::digest(text.as_bytes())),
        }));
    }
    reads.sort_by(|left, right| left["url"].as_str().cmp(&right["url"].as_str()));
    let entry_url = format!("{root_url}plugins/consumer.mjs");
    fs::write(
        stage.join("source-graph.json"),
        json!({
            "schemaVersion": 2,
            "instanceId": "consumer",
            "rootUrl": root_url,
            "entryUrl": entry_url,
            "bundleSha256": "a".repeat(64),
            "configSchema": {"type":"object"},
            "reads": reads,
            "aliases": [
                {
                    "url": format!("{root_url}node_modules/tiny/package.json"),
                    "canonicalUrl": format!("{root_url}node_modules/.pnpm/tiny@1/node_modules/tiny/package.json"),
                }
            ],
            "externalReferences": [],
        }).to_string(),
    ).unwrap();
    let root = parent.canonicalize().unwrap();
    let install = HostPluginInstallation {
        config: json!({}),
        enabled: true,
        export_name: "default".into(),
        id: "consumer".into(),
        integrity: Some("a".repeat(64)),
        source: "./plugin-graphs/r1/consumer/sources/plugins/consumer.mjs".into(),
        source_graph: Some("./plugin-graphs/r1/consumer/source-graph.json".into()),
    };
    let mut prepared = prepare_native_plugins(&[install], &[], &root).unwrap();
    assert_eq!(
        prepared.installations[0].config_schema,
        Some(json!({"type":"object"}))
    );
    assert_eq!(
        prepared.installations[0]
            .resource_graph
            .as_ref()
            .unwrap()
            .entry_url,
        entry_url
    );
    let selected = prepared
        .sources
        .read_resource("holo-plugins:///consumer/node_modules/tiny/package.json")
        .unwrap()
        .unwrap();
    assert!(selected.contains("node_modules/.pnpm/tiny@1/node_modules/tiny/package.json"));
    assert!(
        prepared
            .sources
            .read_resource("holo-plugins:///consumer/node_modules/tiny/other.mjs")
            .unwrap()
            .is_none()
    );
    fs::write(
        sources.join("node_modules/.pnpm/tiny@1/node_modules/tiny/index.mjs"),
        "tampered",
    )
    .unwrap();
    let mut restored = NativePluginSources::from_roots(&prepared.roots).unwrap();
    assert!(restored.install_resource_roots(&prepared.roots).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn same_name_directory_replacement_cannot_mix_schema_and_modules() {
    let parent = std::env::temp_dir().join(format!(
        "holo-plugin-root-swap-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let root = parent.join("plugin");
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let read = open_directory_no_follow(&root).unwrap();
    let read_identity = directory_identity(&read).unwrap();
    fs::rename(&root, parent.join("old-plugin")).unwrap();
    fs::create_dir(&root).unwrap();
    let retained = open_directory_no_follow(&root).unwrap();
    let retained_identity = directory_identity(&retained).unwrap();
    assert!(ensure_root_identity(Some(read_identity), retained_identity).is_err());
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn native_config_package_link_uses_one_physical_root_and_restores_alias_names() {
    use std::os::unix::fs::symlink;
    let parent = std::env::temp_dir().join(format!(
        "holo-native-package-link-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let config = parent.join("project");
    fs::create_dir_all(&config).unwrap();
    let config = config.canonicalize().unwrap();
    #[cfg(target_os = "macos")]
    let absolute_spelling = config
        .strip_prefix("/private/var")
        .map(|suffix| Path::new("/var").join(suffix))
        .unwrap_or_else(|_| config.clone());
    #[cfg(not(target_os = "macos"))]
    let absolute_spelling = config.clone();
    let physical = config.join("node_modules/.pnpm/pkg@1/node_modules/@scope/pkg");
    fs::create_dir_all(&physical).unwrap();
    fs::create_dir_all(config.join("node_modules/@scope")).unwrap();
    fs::write(
        physical.join("package.json"),
        r#"{"holo":{"apiVersion":1,"entry":"./index.mjs","kind":"runtime-plugin","configSchema":"./schema.json"}}"#,
    )
    .unwrap();
    fs::write(physical.join("index.mjs"), "export default () => 1;").unwrap();
    fs::write(physical.join("dep.mjs"), "export const value = 1;").unwrap();
    fs::create_dir(physical.join("lib")).unwrap();
    fs::write(physical.join("lib/decision.mjs"), "export default true;").unwrap();
    fs::write(physical.join("schema.json"), r#"{"type":"object"}"#).unwrap();
    symlink(
        "../.pnpm/pkg@1/node_modules/@scope/pkg",
        config.join("node_modules/@scope/pkg"),
    )
    .unwrap();
    let install = HostPluginInstallation {
        config: json!({}),
        enabled: true,
        export_name: "default".into(),
        id: "plugin".into(),
        integrity: None,
        source: "@scope/pkg".into(),
        source_graph: None,
    };
    for source in [
        "./node_modules/@scope/pkg",
        "./node_modules/@scope/pkg/package.json",
    ] {
        let mut explicit = install.clone();
        explicit.source = source.into();
        let selected = prepare_native_plugins(&[explicit], &[], &config).unwrap();
        assert_eq!(selected.roots[0].root_path, physical);
        assert_eq!(
            selected.installations[0].config_schema,
            Some(json!({"type":"object"}))
        );
    }
    for source in [
        config.join("node_modules/@scope/pkg"),
        config.join("node_modules/@scope/pkg/package.json"),
        absolute_spelling.join("node_modules/@scope/pkg/package.json"),
    ] {
        let mut absolute = install.clone();
        absolute.source = source.to_str().unwrap().into();
        let selected =
            prepare_native_plugins(&[absolute], std::slice::from_ref(&config), &config).unwrap();
        assert_eq!(selected.roots[0].root_path, physical);
        assert_eq!(
            selected.roots[0].requested_root_path,
            Some(config.join("node_modules/@scope/pkg"))
        );
    }
    let mut root_equal = install.clone();
    root_equal.source = physical.to_str().unwrap().into();
    let selected =
        prepare_native_plugins(&[root_equal], std::slice::from_ref(&physical), &config).unwrap();
    assert_eq!(selected.roots[0].root_path, physical);
    fs::write(config.join("safe.mjs"), "export default () => 1;").unwrap();
    symlink("safe.mjs", config.join("linked.mjs")).unwrap();
    let mut linked_file = install.clone();
    linked_file.source = config.join("linked.mjs").to_str().unwrap().into();
    assert!(
        prepare_native_plugins(&[linked_file], std::slice::from_ref(&config), &config).is_err()
    );
    let mut prepared =
        prepare_native_plugins(std::slice::from_ref(&install), &[], &config).unwrap();
    assert_eq!(
        prepared.installations[0].entry_url,
        "holo-plugins:///plugin/index.mjs"
    );
    assert_eq!(
        prepared.installations[0].config_schema,
        Some(json!({"type":"object"}))
    );
    assert_eq!(prepared.roots[0].root_path, physical);
    assert_eq!(
        prepared.roots[0].requested_root_path,
        Some(config.join("node_modules/@scope/pkg"))
    );
    assert!(
        prepared
            .sources
            .read("holo-plugins:///plugin/dep.mjs")
            .unwrap()
            .is_some()
    );
    let admission = crate::SourceAdmission::default();
    admission
        .restore(&prepared.sources.private_sources)
        .unwrap();
    let mut restored = NativePluginSources::from_roots(&prepared.roots).unwrap();
    restored.admission = admission.clone();
    restored.restore_package_names(&prepared.roots).unwrap();
    assert!(
        restored
            .read("holo-plugins:///plugin/lib/package.json")
            .unwrap()
            .is_none()
    );
    assert!(
        restored
            .read("holo-plugins:///plugin/lib/decision.mjs")
            .unwrap()
            .is_some()
    );
    symlink("decision.mjs", physical.join("lib/linked.mjs")).unwrap();
    assert!(
        restored
            .read("holo-plugins:///plugin/lib/linked.mjs")
            .is_err()
    );
    fs::write(physical.join("lib/package.json"), "{}").unwrap();
    let mut guest = crate::SourceStore::with_workspace_root(&config, admission).unwrap();
    assert!(
        guest
            .read_resource("app://workspace/node_modules/@scope/pkg/index.mjs")
            .is_err()
    );
    assert!(
        guest
            .read_resource(
                "app://workspace/node_modules/.pnpm/pkg@1/node_modules/@scope/pkg/index.mjs"
            )
            .is_err()
    );
    for url in [
        "app://workspace/node_modules/@scope/pkg/lib/package.json",
        "app://workspace/node_modules/.pnpm/pkg@1/node_modules/@scope/pkg/lib/package.json",
    ] {
        assert!(guest.read_resource(url).is_err());
    }
    let mut absolute = install.clone();
    absolute.source = absolute_spelling
        .join("node_modules/@scope/pkg/package.json")
        .to_str()
        .unwrap()
        .into();
    let absolute_prepared =
        prepare_native_plugins(&[absolute], std::slice::from_ref(&config), &config).unwrap();
    let replacement = config.join("node_modules/.pnpm/pkg@2/node_modules/@scope/pkg");
    fs::create_dir_all(&replacement).unwrap();
    fs::write(replacement.join("package.json"), "{}").unwrap();
    fs::write(replacement.join("index.mjs"), "export default () => 2;").unwrap();
    fs::remove_file(config.join("node_modules/@scope/pkg")).unwrap();
    symlink(
        "../.pnpm/pkg@2/node_modules/@scope/pkg",
        config.join("node_modules/@scope/pkg"),
    )
    .unwrap();
    let mut rebound_guest = crate::SourceStore::with_workspace_root(
        &config,
        absolute_prepared.sources.admission.clone(),
    )
    .unwrap();
    for url in [
        "app://workspace/node_modules/@scope/pkg/package.json",
        "app://workspace/node_modules/@scope/pkg/index.mjs",
    ] {
        assert!(rebound_guest.read_resource(url).is_err());
    }
    fs::rename(&physical, config.join("retired")).unwrap();
    fs::create_dir(&physical).unwrap();
    fs::write(physical.join("dep.mjs"), "export const value = 2;").unwrap();
    let snapshot = restored
        .read("holo-plugins:///plugin/dep.mjs")
        .unwrap()
        .unwrap();
    let value: Value = serde_json::from_str(&snapshot).unwrap();
    let bytes = value["bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_u64().unwrap() as u8)
        .collect::<Vec<_>>();
    assert_eq!(bytes, b"export const value = 1;");
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn native_link_cannot_escape_config_root_and_parent_physical_search_remains() {
    use std::os::unix::fs::symlink;
    let parent = std::env::temp_dir().join(format!(
        "holo-native-package-scope-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let config = parent.join("project/config");
    fs::create_dir_all(&config).unwrap();
    let config = config.canonicalize().unwrap();
    let package = config.parent().unwrap().join("node_modules/pkg");
    fs::create_dir_all(&package).unwrap();
    fs::write(
        package.join("package.json"),
        r#"{"holo":{"apiVersion":1,"entry":"./index.mjs","kind":"runtime-plugin"}}"#,
    )
    .unwrap();
    fs::write(package.join("index.mjs"), "export default () => 1;").unwrap();
    let install = HostPluginInstallation {
        config: json!({}),
        enabled: true,
        export_name: "default".into(),
        id: "plugin".into(),
        integrity: None,
        source: "pkg".into(),
        source_graph: None,
    };
    let old = prepare_native_plugins(std::slice::from_ref(&install), &[], &config).unwrap();
    assert_eq!(old.roots[0].root_path, package);
    fs::create_dir(config.join("node_modules")).unwrap();
    symlink("../../../node_modules/pkg", config.join("node_modules/pkg")).unwrap();
    for source in [
        "pkg",
        "./node_modules/pkg",
        "./node_modules/pkg/package.json",
        "./node_modules/pkg/index.mjs",
        config.join("node_modules/pkg").to_str().unwrap(),
        config
            .join("node_modules/pkg/package.json")
            .to_str()
            .unwrap(),
    ] {
        let mut case = install.clone();
        case.source = source.into();
        let roots = if source.starts_with('/') {
            vec![config.clone()]
        } else {
            vec![]
        };
        assert!(prepare_native_plugins(&[case], &roots, &config).is_err());
    }
    let selected = parent.join("selected/subdir");
    fs::create_dir_all(&selected).unwrap();
    fs::write(selected.join("module.mjs"), "export default () => 1;").unwrap();
    symlink(parent.join("selected"), config.join("ancestor-link")).unwrap();
    let mut ancestor_alias = install.clone();
    ancestor_alias.source = config
        .join("ancestor-link/subdir/module.mjs")
        .to_str()
        .unwrap()
        .into();
    assert!(prepare_native_plugins(&[ancestor_alias], &[selected], &config).is_err());
    fs::remove_dir_all(parent).unwrap();
}
