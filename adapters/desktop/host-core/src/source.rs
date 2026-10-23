use crate::{MAX_GRAPH_BYTES, MAX_MODULE_BYTES, MAX_MODULES};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::{CString, OsString};
use std::fs::File;
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use url::Url;

/// Private launch facts, obtained from the same descriptor as the Host bytes.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PrivateSource {
    pub path: PathBuf,
    pub device: u64,
    pub inode: u64,
}

#[cfg(test)]
mod private_source_root_tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn host_resource_alias_has_one_canonical_snapshot_and_keeps_guest_role_private() {
        let root = std::env::temp_dir().join(format!(
            "holo-private-resource-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let physical = root.join("node_modules/.pnpm/tiny@1/node_modules/tiny");
        fs::create_dir_all(&physical).unwrap();
        fs::write(
            physical.join("package.json"),
            r#"{"name":"tiny","type":"module","exports":{".":"./index.mjs"}}"#,
        )
        .unwrap();
        fs::write(physical.join("index.mjs"), "export const value = 1;").unwrap();
        symlink(
            ".pnpm/tiny@1/node_modules/tiny",
            root.join("node_modules/tiny"),
        )
        .unwrap();
        let root = root.canonicalize().unwrap();
        let admission = SourceAdmission::default();
        let mut private =
            PrivateSourceRoot::open(&root, "holo-plugins:///plugin/", admission.clone()).unwrap();
        assert_eq!(
            private_resource_url(
                "holo-plugins:///plugin/",
                Path::new("node_modules/tiny/package.json"),
            )
            .unwrap(),
            "holo-plugins:///plugin/node_modules/tiny/package.json"
        );
        let manifest = private
            .read_resource("holo-plugins:///plugin/node_modules/tiny/package.json")
            .unwrap()
            .unwrap();
        assert_eq!(
            manifest.canonical_url,
            "holo-plugins:///plugin/node_modules/.pnpm/tiny@1/node_modules/tiny/package.json"
        );
        let first = private
            .read_resource("holo-plugins:///plugin/node_modules/tiny/index.mjs")
            .unwrap()
            .unwrap();
        let second = private
            .read_resource(
                "holo-plugins:///plugin/node_modules/.pnpm/tiny@1/node_modules/tiny/index.mjs",
            )
            .unwrap()
            .unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(private.canonical.len(), 2);
        fs::hard_link(physical.join("index.mjs"), root.join("hardlink.mjs")).unwrap();
        assert!(
            private
                .read_resource("holo-plugins:///plugin/node_modules/missing/package.json")
                .unwrap()
                .is_none()
        );
        fs::create_dir(root.join("node_modules/missing")).unwrap();
        fs::write(root.join("node_modules/missing/package.json"), "{}").unwrap();
        let mut guest = SourceStore::with_workspace_root(&root, admission).unwrap();
        assert!(
            guest
                .read_resource("app://workspace/node_modules/tiny/index.mjs")
                .is_err()
        );
        assert!(guest.read_resource("app://workspace/hardlink.mjs").is_err());
        assert!(
            guest
                .read_resource("app://workspace/node_modules/missing/package.json")
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn package_rebind_does_not_mix_new_module_with_pinned_manifest() {
        let root = std::env::temp_dir().join(format!(
            "holo-private-rebind-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = root.join("node_modules/.pnpm/tiny@1/node_modules/tiny");
        let second = root.join("node_modules/.pnpm/tiny@2/node_modules/tiny");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(
            first.join("package.json"),
            r#"{"name":"tiny","version":"1"}"#,
        )
        .unwrap();
        fs::write(
            second.join("package.json"),
            r#"{"name":"tiny","version":"2"}"#,
        )
        .unwrap();
        fs::write(first.join("index.mjs"), "export const version = 1;").unwrap();
        fs::write(second.join("index.mjs"), "export const version = 2;").unwrap();
        let alias = root.join("node_modules/tiny");
        symlink(".pnpm/tiny@1/node_modules/tiny", &alias).unwrap();
        let root = root.canonicalize().unwrap();
        let mut private =
            PrivateSourceRoot::open(&root, "holo-plugins:///plugin/", SourceAdmission::default())
                .unwrap();
        let manifest = private
            .read_resource("holo-plugins:///plugin/node_modules/tiny/package.json")
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&manifest.bytes).contains(r#""version":"1""#));
        fs::remove_file(&alias).unwrap();
        symlink(".pnpm/tiny@2/node_modules/tiny", &alias).unwrap();
        let module = private
            .read_resource("holo-plugins:///plugin/node_modules/tiny/index.mjs")
            .unwrap()
            .unwrap();
        assert_eq!(module.bytes, b"export const version = 1;");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn many_aliases_share_one_physical_package_lease_and_rebind_keeps_old_bytes() {
        let root = std::env::temp_dir().join(format!(
            "holo-private-many-aliases-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let old = root.join("node_modules/.pnpm/shared@1/node_modules/shared");
        let next = root.join("node_modules/.pnpm/shared@2/node_modules/shared");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&next).unwrap();
        fs::write(
            old.join("package.json"),
            r#"{"name":"shared","version":"1"}"#,
        )
        .unwrap();
        fs::write(
            next.join("package.json"),
            r#"{"name":"shared","version":"2"}"#,
        )
        .unwrap();
        fs::write(old.join("index.mjs"), "export const version = 1;").unwrap();
        fs::write(next.join("index.mjs"), "export const version = 2;").unwrap();
        for index in 0..130 {
            symlink(
                ".pnpm/shared@1/node_modules/shared",
                root.join(format!("node_modules/alias-{index}")),
            )
            .unwrap();
        }
        let root = root.canonicalize().unwrap();
        let budget = Arc::new(Mutex::new(PrivateResourceBudget::default()));
        let mut private = PrivateSourceRoot::open_with_budget(
            &root,
            "holo-plugins:///plugin/",
            SourceAdmission::default(),
            budget.clone(),
        )
        .unwrap();
        let mut first = None;
        for index in 0..130 {
            let resource = private
                .read_resource(&format!(
                    "holo-plugins:///plugin/node_modules/alias-{index}/package.json"
                ))
                .unwrap()
                .unwrap();
            if let Some(first) = &first {
                assert!(Arc::ptr_eq(first, &resource));
            } else {
                first = Some(resource);
            }
        }
        assert_eq!(private.packages.len(), 130);
        assert_eq!(budget.lock().unwrap().package_leases, 1);
        let alias = root.join("node_modules/alias-129");
        fs::remove_file(&alias).unwrap();
        symlink(".pnpm/shared@2/node_modules/shared", &alias).unwrap();
        let module = private
            .read_resource("holo-plugins:///plugin/node_modules/alias-129/index.mjs")
            .unwrap()
            .unwrap();
        assert_eq!(module.bytes, b"export const version = 1;");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_root_seed_reuses_original_package_fd_after_directory_rebind() {
        let root = std::env::temp_dir().join(format!(
            "holo-private-seeded-rebind-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let original = root.join("node_modules/.pnpm/pkg@1/node_modules/pkg");
        fs::create_dir_all(&original).unwrap();
        fs::write(original.join("package.json"), r#"{"name":"pkg"}"#).unwrap();
        fs::write(original.join("schema.json"), r#"{"old":true}"#).unwrap();
        fs::write(original.join("index.mjs"), "export default 'old';").unwrap();
        symlink(
            ".pnpm/pkg@1/node_modules/pkg",
            root.join("node_modules/pkg"),
        )
        .unwrap();
        let root = root.canonicalize().unwrap();
        let admission = SourceAdmission::default();
        let (package, mut manifest) = PrivatePackage::open(
            &root,
            &root.join("node_modules/pkg/package.json"),
            &admission,
        )
        .unwrap()
        .unwrap();
        let mut manifest_bytes = Vec::new();
        manifest.read_to_end(&mut manifest_bytes).unwrap();
        let mut schema = package
            .read(Path::new("schema.json"), &admission)
            .unwrap()
            .unwrap();
        let mut schema_bytes = Vec::new();
        schema.read_to_end(&mut schema_bytes).unwrap();
        let hashes = HashMap::from([
            (
                PathBuf::from("package.json"),
                format!("{:x}", Sha256::digest(&manifest_bytes)),
            ),
            (
                PathBuf::from("schema.json"),
                format!("{:x}", Sha256::digest(&schema_bytes)),
            ),
        ]);
        fs::rename(&original, original.with_file_name("pkg-old")).unwrap();
        fs::create_dir(&original).unwrap();
        fs::write(
            original.join("package.json"),
            r#"{"name":"pkg","new":true}"#,
        )
        .unwrap();
        fs::write(original.join("schema.json"), r#"{"new":true}"#).unwrap();
        fs::write(original.join("index.mjs"), "export default 'new';").unwrap();
        let budget = Arc::new(Mutex::new(PrivateResourceBudget::default()));
        let mut private = PrivateSourceRoot::open_with_budget(
            &root,
            "holo-plugins:///plugin/",
            admission,
            budget.clone(),
        )
        .unwrap();
        private.seed_package(Arc::new(package), &hashes).unwrap();
        {
            let mut budget = budget.lock().unwrap();
            budget.external_bytes = MAX_GRAPH_BYTES;
            budget.external_read_count = MAX_MODULES;
        }
        let manifest = private
            .read_resource("holo-plugins:///plugin/node_modules/pkg/package.json")
            .unwrap()
            .unwrap();
        assert_eq!(manifest.bytes, manifest_bytes);
        {
            let mut budget = budget.lock().unwrap();
            budget.external_bytes = 0;
            budget.external_read_count = 0;
        }
        let module = private
            .read_resource(
                "holo-plugins:///plugin/node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs",
            )
            .unwrap()
            .unwrap();
        assert_eq!(module.bytes, b"export default 'old';");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pinned_direct_entry_without_manifest_keeps_missing_package_probe_null() {
        let root = std::env::temp_dir().join(format!(
            "holo-private-direct-root-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("plugin.mjs"), "export default () => {};").unwrap();
        let root = root.canonicalize().unwrap();
        let pinned = PrivatePackage::from_pinned_directory(
            PrivatePackage::open_selected_root(&root).unwrap(),
            root.clone(),
            root.clone(),
        )
        .unwrap();
        let mut private =
            PrivateSourceRoot::open(&root, "holo-plugins:///plugin/", SourceAdmission::default())
                .unwrap();
        private.seed_pinned_directory(Arc::new(pinned)).unwrap();
        assert!(
            private
                .read_resource("holo-plugins:///plugin/package.json")
                .unwrap()
                .is_none()
        );
        assert!(
            private
                .read_resource("holo-plugins:///plugin/plugin.mjs")
                .unwrap()
                .is_some()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pinned_package_walker_keeps_nested_physical_and_within_root_link_reads() {
        let root = std::env::temp_dir().join(format!(
            "holo-private-pinned-nested-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let package_root = root.join("node_modules/pkg");
        fs::create_dir_all(package_root.join("node_modules/physical")).unwrap();
        fs::create_dir_all(root.join("shared")).unwrap();
        fs::write(package_root.join("package.json"), r#"{"name":"pkg"}"#).unwrap();
        fs::write(
            package_root.join("node_modules/physical/index.mjs"),
            "export default 'PHYSICAL';",
        )
        .unwrap();
        fs::write(
            root.join("shared/package.json"),
            r#"{"name":"linked","stamp":"OLD"}"#,
        )
        .unwrap();
        fs::write(
            root.join("shared/early.mjs"),
            "export default 'LINKED_EARLY';",
        )
        .unwrap();
        fs::write(root.join("shared/index.mjs"), "export default 'LINKED';").unwrap();
        symlink("../../../shared", package_root.join("node_modules/linked")).unwrap();
        let root = root.canonicalize().unwrap();
        let package_root = root.join("node_modules/pkg");
        let pinned = PrivatePackage::from_pinned_directory(
            PrivatePackage::open_selected_root(&package_root).unwrap(),
            package_root.clone(),
            package_root.clone(),
        )
        .unwrap();
        let mut private =
            PrivateSourceRoot::open(&root, "holo-plugins:///plugin/", SourceAdmission::default())
                .unwrap();
        private.seed_pinned_directory(Arc::new(pinned)).unwrap();
        let physical = private
            .read_resource(
                "holo-plugins:///plugin/node_modules/pkg/node_modules/physical/index.mjs",
            )
            .unwrap()
            .unwrap();
        assert_eq!(physical.bytes, b"export default 'PHYSICAL';");
        let linked = private
            .read_resource("holo-plugins:///plugin/node_modules/pkg/node_modules/linked/early.mjs")
            .unwrap()
            .unwrap();
        assert_eq!(linked.bytes, b"export default 'LINKED_EARLY';");
        let linked_manifest = private
            .read_resource(
                "holo-plugins:///plugin/node_modules/pkg/node_modules/linked/package.json",
            )
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&linked_manifest.bytes).contains("OLD"));
        fs::rename(root.join("shared"), root.join("shared-old")).unwrap();
        fs::create_dir(root.join("shared")).unwrap();
        fs::write(
            root.join("shared/package.json"),
            r#"{"name":"linked","stamp":"NEW"}"#,
        )
        .unwrap();
        fs::write(
            root.join("shared/index.mjs"),
            "export default 'NEW_LINKED';",
        )
        .unwrap();
        let linked_after_rebind = private
            .read_resource("holo-plugins:///plugin/node_modules/pkg/node_modules/linked/index.mjs")
            .unwrap()
            .unwrap();
        assert_eq!(linked_after_rebind.bytes, b"export default 'LINKED';");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_root_package_metadata_stays_exclusive_between_host_and_guest() {
        let root = std::env::temp_dir().join(format!(
            "holo-private-root-manifest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("plugins")).unwrap();
        fs::write(root.join("package.json"), r#"{"type":"module"}"#).unwrap();
        fs::write(root.join("plugins/gate.mjs"), "export default () => {};").unwrap();
        fs::write(root.join("index.js"), "console.log('guest');").unwrap();
        let root = root.canonicalize().unwrap();
        let admission = SourceAdmission::default();
        let mut private =
            PrivateSourceRoot::open(&root, "holo-plugins:///gate/", admission.clone()).unwrap();
        assert!(
            private
                .read_resource("holo-plugins:///gate/package.json")
                .unwrap()
                .is_some()
        );
        let mut guest = SourceStore::with_workspace_root(&root, admission).unwrap();
        let failure = guest
            .read_resource("app://workspace/package.json")
            .unwrap_err();
        assert!(failure.contains("Private source namespace") || failure.contains("Host and Guest"));
        assert!(
            guest
                .read_resource_with_purpose(
                    "app://workspace/package.json",
                    SourceReadPurpose::PackageMetadata,
                )
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn weak_host_package_metadata_is_planner_only_and_guest_first_stays_source() {
        let root = std::env::temp_dir().join(format!(
            "holo-weak-package-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("package.json"), r#"{"type":"module"}"#).unwrap();
        fs::write(root.join("index.js"), "export default 1;").unwrap();
        let root = root.canonicalize().unwrap();
        let admission = SourceAdmission::default();
        let mut host =
            PrivateSourceRoot::open(&root, "holo-plugins:///gate/", admission.clone()).unwrap();
        host.read_resource_with_purpose(
            "holo-plugins:///gate/package.json",
            SourceReadPurpose::PackageMetadata,
        )
        .unwrap()
        .unwrap();
        let mut guest = SourceStore::with_workspace_root(&root, admission).unwrap();
        assert!(guest.read_resource("app://workspace/package.json").is_err());
        let metadata = guest
            .read_resource_with_purpose(
                "app://workspace/package.json",
                SourceReadPurpose::PackageMetadata,
            )
            .unwrap()
            .unwrap();
        assert!(metadata.metadata_only);
        assert!(guest.read_resource("app://workspace/package.json").is_err());
        assert!(
            !guest
                .read_resource("app://workspace/index.js")
                .unwrap()
                .unwrap()
                .metadata_only
        );
        fs::write(root.join("package.json"), r#"{"type":"commonjs"}"#).unwrap();
        assert!(
            guest
                .read_resource_with_purpose(
                    "app://workspace/package.json",
                    SourceReadPurpose::PackageMetadata,
                )
                .is_err()
        );
        fs::remove_dir_all(&root).unwrap();

        let root = std::env::temp_dir().join(format!("holo-guest-first-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("package.json"), r#"{"type":"module"}"#).unwrap();
        let root = root.canonicalize().unwrap();
        let admission = SourceAdmission::default();
        let mut guest = SourceStore::with_workspace_root(&root, admission.clone()).unwrap();
        assert!(
            !guest
                .read_resource_with_purpose(
                    "app://workspace/package.json",
                    SourceReadPurpose::PackageMetadata,
                )
                .unwrap()
                .unwrap()
                .metadata_only
        );
        assert!(
            guest
                .read_resource("app://workspace/package.json")
                .unwrap()
                .is_some()
        );
        let mut host = PrivateSourceRoot::open(&root, "holo-plugins:///gate/", admission).unwrap();
        assert!(
            host.read_resource_with_purpose(
                "holo-plugins:///gate/package.json",
                SourceReadPurpose::PackageMetadata,
            )
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restricted_strict_cache_rechecks_later_strong_inode_promotion() {
        let root =
            std::env::temp_dir().join(format!("holo-metadata-upgrade-{}", std::process::id()));
        fs::create_dir_all(root.join("alias")).unwrap();
        fs::write(root.join("package.json"), r#"{"type":"module"}"#).unwrap();
        fs::hard_link(root.join("package.json"), root.join("alias/package.json")).unwrap();
        let root = root.canonicalize().unwrap();
        let admission = SourceAdmission::default();
        let mut host =
            PrivateSourceRoot::open(&root, "holo-plugins:///gate/", admission.clone()).unwrap();
        host.read_resource_with_purpose(
            "holo-plugins:///gate/package.json",
            SourceReadPurpose::PackageMetadata,
        )
        .unwrap()
        .unwrap();
        let mut guest = SourceStore::with_workspace_root(&root, admission).unwrap();
        let alias = "app://workspace/alias/package.json";
        assert!(
            guest
                .read_with_purpose(alias, SourceReadPurpose::PackageMetadata)
                .unwrap()
                .unwrap()
                .contains("metadataOnly")
        );
        host.read_resource("holo-plugins:///gate/package.json")
            .unwrap()
            .unwrap();
        assert!(
            guest
                .read_with_purpose(alias, SourceReadPurpose::PackageMetadata)
                .is_err()
        );
        assert!(
            guest
                .read_resource_with_purpose(alias, SourceReadPurpose::PackageMetadata)
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v4_physical_package_flag_blocks_query_and_flat_alias_after_metadata_cache() {
        let root = std::env::temp_dir().join(format!("holo-v4-metadata-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("entry.mjs"), "export default 1;").unwrap();
        fs::write(root.join("package.json"), r#"{"type":"module"}"#).unwrap();
        let root = root.canonicalize().unwrap();
        let mut guest = SourceStore::with_workspace_entry(
            &root,
            &root.join("entry.mjs"),
            SourceAdmission::default(),
        )
        .unwrap();
        let metadata = "app://workspace/package.json";
        let alias = "app://workspace/alias/package.json";
        let query = "app://workspace/package.json?revision=2";
        let casing = "app://workspace/PACKAGE.JSON";
        guest
            .restrict_to_urls(vec![
                guest.entry_url.clone(),
                metadata.into(),
                alias.into(),
                query.into(),
                casing.into(),
            ])
            .unwrap();
        guest
            .install_aliases(vec![ModuleAlias {
                url: alias.into(),
                canonical_url: metadata.into(),
            }])
            .unwrap();
        guest.restrict_metadata_only(vec![metadata.into()]).unwrap();
        assert!(
            guest
                .read_resource_with_purpose(metadata, SourceReadPurpose::PackageMetadata)
                .unwrap()
                .unwrap()
                .metadata_only
        );
        assert!(guest.read_resource(metadata).is_err());
        assert!(guest.read_resource(query).is_err());
        assert!(guest.read_resource(alias).is_err());
        assert!(guest.read_resource(casing).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn private_directory_reservation_blocks_descendants_and_renamed_fd() {
        let root = std::env::temp_dir().join(format!("holo-private-dir-{}", std::process::id()));
        let home = root.join("private/holo-service");
        fs::create_dir_all(home.join("state")).unwrap();
        fs::write(home.join("state/state.json"), "{\"secret\":true}").unwrap();
        let root = root.canonicalize().unwrap();
        let admission = SourceAdmission::default();
        admission.reserve_private_directory(&home).unwrap();
        let mut guest = SourceStore::with_workspace_root(&root, admission.clone()).unwrap();
        assert!(
            guest
                .read_resource("app://workspace/private/holo-service/state/state.json")
                .is_err()
        );
        fs::rename(&home, root.join("private/renamed")).unwrap();
        assert_eq!(admission.0.lock().unwrap().private_directories.len(), 1);
        assert!(
            admission
                .0
                .lock()
                .unwrap()
                .private_directories
                .values()
                .next()
                .unwrap()
                .is_some()
        );
        assert!(
            admission
                .check_private_directory_identity(
                    &File::open(root.join("private/renamed")).unwrap()
                )
                .is_err()
        );
        let moved = guest.read_resource("app://workspace/private/renamed/state/state.json");
        assert!(moved.is_err(), "{moved:?}");
        let missing = root.join("private/later");
        admission.reserve_private_directory(&missing).unwrap();
        fs::create_dir_all(&missing).unwrap();
        fs::write(missing.join("state.json"), "{}").unwrap();
        assert!(
            guest
                .read("app://workspace/private/later/state.json")
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn private_resource_budget_is_shared_across_pinned_roots() {
        let root = std::env::temp_dir().join(format!(
            "holo-private-budget-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("first.mjs"), "export const first = 1;").unwrap();
        fs::write(root.join("second.mjs"), "export const second = 2;").unwrap();
        fs::write(root.join("package.json"), r#"{"type":"module"}"#).unwrap();
        let root = root.canonicalize().unwrap();
        let budget = Arc::new(Mutex::new(PrivateResourceBudget::default()));
        let admission = SourceAdmission::default();
        let mut first = PrivateSourceRoot::open_with_budget(
            &root,
            "holo-plugins:///first/",
            admission.clone(),
            budget.clone(),
        )
        .unwrap();
        let mut second = PrivateSourceRoot::open_with_budget(
            &root,
            "holo-plugins:///second/",
            admission,
            budget.clone(),
        )
        .unwrap();
        assert!(
            first
                .read_resource("holo-plugins:///first/first.mjs")
                .unwrap()
                .is_some()
        );
        budget.lock().unwrap().total_bytes = MAX_GRAPH_BYTES;
        assert!(
            second
                .read_resource("holo-plugins:///second/second.mjs")
                .unwrap_err()
                .contains("aggregate limit")
        );
        budget.lock().unwrap().package_leases = 128;
        assert!(
            second
                .read_resource("holo-plugins:///second/package.json")
                .unwrap_err()
                .contains("package source aggregate limit")
        );
        fs::remove_dir_all(root).unwrap();
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModuleAlias {
    pub url: String,
    pub canonical_url: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct SourceResource {
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub canonical_url: String,
    pub metadata_only: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SourceReadPurpose {
    #[default]
    Module,
    PackageMetadata,
}

impl SourceReadPurpose {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "module" => Ok(Self::Module),
            "packageMetadata" => Ok(Self::PackageMetadata),
            _ => Err("Invalid source read purpose".into()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PrivateResourceRead {
    pub url: String,
    pub byte_length: usize,
    pub sha256: String,
}

#[derive(Debug, Default)]
pub(crate) struct PrivateResourceBudget {
    pub(crate) canonical: HashMap<String, (usize, String)>,
    pub(crate) total_bytes: usize,
    pub(crate) package_leases: usize,
    pub(crate) external_bytes: usize,
    pub(crate) external_package_leases: usize,
    pub(crate) external_read_count: usize,
}

/// One generation's source-domain admission, shared by the existing readers.
/// Pins prevent inode reuse; labels never roll back after a failed watch attempt.
/// This is not a resolver or a byte cache. Explicit Host FS grants are separate.
#[derive(Clone, Debug, Default)]
pub struct SourceAdmission(Arc<Mutex<SourceLabels>>);

#[derive(Debug, Default)]
struct SourceLabels {
    files: HashMap<(u64, u64), (bool, File)>,
    slots: HashMap<(u64, u64, std::ffi::OsString), File>,
    namespaces: HashSet<PathBuf>,
    private_directories: HashMap<PathBuf, Option<File>>,
    metadata_files: HashMap<(u64, u64), (File, String)>,
    metadata_slots: HashMap<SourceSlotKey, MetadataSlot>,
    metadata_namespaces: HashMap<PathBuf, (u64, u64)>,
    metadata_missing_namespaces: HashSet<PathBuf>,
    metadata_missing_slots: HashMap<(u64, u64, std::ffi::OsString), File>,
    guest_slots: HashMap<(u64, u64, std::ffi::OsString), File>,
    guest_namespaces: HashSet<PathBuf>,
    audit_files: HashSet<(u64, u64)>,
    audit_slots: HashSet<(u64, u64, std::ffi::OsString)>,
}

type SourceSlotKey = (u64, u64, std::ffi::OsString);

#[derive(Debug)]
struct MetadataSlot {
    identity: (u64, u64),
    _parent: File,
}

impl SourceLabels {
    fn len(&self) -> usize {
        self.files.len()
            + self.slots.len()
            + self.namespaces.len()
            + self.private_directories.len()
            + self.metadata_files.len()
            + self.metadata_slots.len()
            + self.metadata_namespaces.len()
            + self.metadata_missing_namespaces.len()
            + self.metadata_missing_slots.len()
            + self.guest_slots.len()
            + self.guest_namespaces.len()
    }
}

impl SourceAdmission {
    pub const LIMIT: usize = 4096;
    /// Owner-private directory namespace, including descendants. Existing
    /// directory descriptors remain pinned so a later rename cannot expose
    /// the same tree through a different Guest spelling.
    pub fn reserve_private_directory(&self, path: &Path) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        if !strict_package_absolute(path) || path == Path::new("/") {
            return Err("Invalid private source directory".into());
        }
        #[cfg(target_os = "macos")]
        let path = if let Ok(relative) = path.strip_prefix("/var")
            && crate::plugins::trusted_macos_var_alias()
        {
            Path::new("/private/var").join(relative)
        } else {
            path.to_path_buf()
        };
        #[cfg(not(target_os = "macos"))]
        let path = path.to_path_buf();
        let path = path.as_path();
        let root = File::open("/").map_err(|_| "Source root unavailable")?;
        let directory = match open_confined(
            &root,
            path.strip_prefix("/")
                .map_err(|_| "Invalid private source directory")?,
        ) {
            Ok(file) => {
                if !file
                    .metadata()
                    .map_err(|_| "Private source directory unavailable")?
                    .is_dir()
                {
                    return Err("Private source directory must be a directory".into());
                }
                Some(file)
            }
            Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => {
                None
            }
            Err(_) => return Err("Private source directory is unavailable or not confined".into()),
        };
        {
            let labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
            for guest in &labels.guest_namespaces {
                if equivalent_path_prefix(path, guest)? {
                    return Err("Private directory conflicts with Guest source".into());
                }
            }
            if let Some(previous) = labels.private_directories.get(path)
                && let (Some(previous), Some(current)) = (previous, &directory)
            {
                let before = previous
                    .metadata()
                    .map_err(|_| "Private directory identity unavailable")?;
                let after = current
                    .metadata()
                    .map_err(|_| "Private directory identity unavailable")?;
                if (before.dev(), before.ino()) != (after.dev(), after.ino()) {
                    return Err("Private directory identity changed".into());
                }
            }
        }
        self.reserve_private_path(path)?;
        let mut labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        if !labels.private_directories.contains_key(path) && labels.len() >= Self::LIMIT {
            return Err("Source identity limit exceeded; restart required".into());
        }
        let entry = labels
            .private_directories
            .entry(path.to_path_buf())
            .or_insert(None);
        if entry.is_none() {
            *entry = directory;
        }
        Ok(())
    }
    fn check_private_directory_identity(&self, directory: &File) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        let current = directory
            .metadata()
            .map_err(|_| "Source directory unavailable")?;
        let labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        for pinned in labels.private_directories.values().flatten() {
            let previous = pinned
                .metadata()
                .map_err(|_| "Private directory identity unavailable")?;
            if (current.dev(), current.ino()) == (previous.dev(), previous.ino()) {
                return Err("Private source directory".into());
            }
        }
        Ok(())
    }
    fn admit(&self, file: &File, host: bool) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata().map_err(|_| "Source identity unavailable")?;
        if !metadata.is_file() {
            return Err("Source must be a regular file".into());
        }
        let key = (metadata.dev(), metadata.ino());
        let mut labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        if labels.audit_files.contains(&key) {
            return Err("Audit identity cannot be a source".into());
        }
        if !host && labels.metadata_files.contains_key(&key) {
            return Err("Host package metadata is not Guest source".into());
        }
        if let Some((previous, _)) = labels.files.get(&key) {
            return if *previous == host {
                Ok(())
            } else {
                Err("Host and Guest source identity conflict".into())
            };
        }
        if labels.len() >= Self::LIMIT {
            return Err("Source identity limit exceeded; restart required".into());
        }
        labels.files.insert(
            key,
            (
                host,
                file.try_clone().map_err(|_| "Cannot pin source identity")?,
            ),
        );
        Ok(())
    }
    pub fn host(&self, file: &File) -> Result<(), String> {
        self.admit(file, true)
    }
    pub fn host_slot(&self, parent: &File, name: &std::ffi::OsStr) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        let metadata = parent
            .metadata()
            .map_err(|_| "Source directory unavailable")?;
        let key = (metadata.dev(), metadata.ino(), name.to_os_string());
        let mut labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        for (device, inode, guest_name) in labels.guest_slots.keys() {
            if (*device, *inode) == (metadata.dev(), metadata.ino())
                && equivalent_name(guest_name, name)?
            {
                return Err("Host and Guest source slot conflict".into());
            }
        }
        for (device, inode, audit_name) in &labels.audit_slots {
            if (*device, *inode) == (metadata.dev(), metadata.ino())
                && equivalent_name(audit_name, name)?
            {
                return Err("Audit slot cannot be a source".into());
            }
        }
        if labels.slots.contains_key(&key) {
            return Ok(());
        }
        if labels.len() >= Self::LIMIT {
            return Err("Source identity limit exceeded; restart required".into());
        }
        labels.slots.insert(
            key,
            parent
                .try_clone()
                .map_err(|_| "Cannot pin source directory")?,
        );
        Ok(())
    }
    pub(crate) fn audit_slot_available(
        &self,
        parent: &File,
        name: &std::ffi::OsStr,
    ) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        let parent = parent
            .metadata()
            .map_err(|_| "Audit directory identity unavailable")?;
        let labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        for (device, inode, previous) in labels.slots.keys() {
            if (*device, *inode) == (parent.dev(), parent.ino()) && equivalent_name(previous, name)?
            {
                return Err("Audit slot conflicts with an existing source".into());
            }
        }
        Ok(())
    }
    pub(crate) fn audit(
        &self,
        parent: &File,
        name: &std::ffi::OsStr,
        file: &File,
    ) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        let directory = parent
            .metadata()
            .map_err(|_| "Audit directory identity unavailable")?;
        let metadata = file
            .metadata()
            .map_err(|_| "Audit file identity unavailable")?;
        let file_key = (metadata.dev(), metadata.ino());
        let slot_key = (directory.dev(), directory.ino(), name.to_os_string());
        let mut labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        if labels.files.contains_key(&file_key) {
            return Err("Audit identity conflicts with an existing source".into());
        }
        for (device, inode, previous) in labels.slots.keys() {
            if (*device, *inode) == (directory.dev(), directory.ino())
                && equivalent_name(previous, name)?
            {
                return Err("Audit slot conflicts with an existing source".into());
            }
        }
        if labels.len() + 2 > Self::LIMIT {
            return Err("Source identity limit exceeded; restart required".into());
        }
        let file_pin = file.try_clone().map_err(|_| "Cannot pin audit identity")?;
        let parent_pin = parent
            .try_clone()
            .map_err(|_| "Cannot pin audit directory")?;
        labels.files.insert(file_key, (true, file_pin));
        labels.slots.insert(slot_key.clone(), parent_pin);
        labels.audit_files.insert(file_key);
        labels.audit_slots.insert(slot_key);
        Ok(())
    }
    pub(crate) fn reserve_namespace(&self, path: &Path) -> Result<(), String> {
        if !path.is_absolute() {
            return Err("Invalid private source namespace".into());
        }
        let mut labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        for guest in &labels.guest_namespaces {
            if equivalent_path(guest, path)? {
                return Err("Host and Guest source namespace conflict".into());
            }
        }
        if labels.namespaces.contains(path) {
            return Ok(());
        }
        if labels.len() >= Self::LIMIT {
            return Err("Source identity limit exceeded; restart required".into());
        }
        labels.namespaces.insert(path.into());
        Ok(())
    }
    /// Reserve the original private name even when its leaf is currently absent.
    /// A later replacement cannot be promoted into the Guest source graph.
    pub(crate) fn reserve_private_path(&self, path: &Path) -> Result<(), String> {
        self.reserve_namespace(path)?;
        let parent_path = path.parent().ok_or("Invalid private source path")?;
        let root = File::open("/").map_err(|_| "Source root unavailable")?;
        let parent = if parent_path == Path::new("/") {
            root
        } else {
            match open_confined(
                &root,
                parent_path
                    .strip_prefix("/")
                    .map_err(|_| "Invalid private source path")?,
            ) {
                Ok(parent) => parent,
                Err(error)
                    if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) =>
                {
                    return Ok(());
                }
                Err(_) => return Err("Private source directory unavailable".into()),
            }
        };
        self.host_slot(
            &parent,
            path.file_name().ok_or("Invalid private source path")?,
        )
    }
    /// Package aliases may have a directory link in node_modules, so their
    /// requested name cannot be reserved by the ordinary nofollow parent walk.
    /// The resolved parent is the one used to open the bytes.
    pub(crate) fn host_package_name(
        &self,
        requested: &Path,
        resolved: &Path,
        parent: Option<&File>,
        name: Option<&std::ffi::OsStr>,
        file: Option<&File>,
    ) -> Result<(), String> {
        if let Some(file) = file {
            self.host(file)?;
        }
        self.reserve_namespace(requested)?;
        self.reserve_namespace(resolved)?;
        if let (Some(parent), Some(name)) = (parent, name) {
            self.host_slot(parent, name)?;
        }
        Ok(())
    }
    /// A Loader package probe shares only an immutable metadata snapshot.
    /// It never claims the strong Host source namespace used by selected
    /// manifests, configuration, Schema, code, or audit identities.
    pub(crate) fn host_package_metadata(
        &self,
        requested: &Path,
        resolved: &Path,
        parent: &File,
        name: &std::ffi::OsStr,
        file: &File,
        sha256: &str,
    ) -> Result<bool, String> {
        use std::os::unix::fs::MetadataExt;
        if requested.file_name() != Some(std::ffi::OsStr::new("package.json"))
            || resolved.file_name() != Some(std::ffi::OsStr::new("package.json"))
            || name != "package.json"
            || !requested.is_absolute()
            || !resolved.is_absolute()
            || sha256.len() != 64
            || !sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("Invalid Host package metadata source".into());
        }
        let metadata = file.metadata().map_err(|_| "Source identity unavailable")?;
        let directory = parent
            .metadata()
            .map_err(|_| "Source directory unavailable")?;
        if !metadata.is_file() || !directory.is_dir() {
            return Err("Host package metadata must be a regular file".into());
        }
        let key = (metadata.dev(), metadata.ino());
        let slot = (directory.dev(), directory.ino(), name.to_os_string());
        let mut labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        if labels.audit_files.contains(&key)
            || labels.files.get(&key).is_some_and(|(host, _)| !host)
        {
            return Err("Host package metadata conflicts with Guest or audit source".into());
        }
        if labels
            .metadata_files
            .get(&key)
            .is_some_and(|(_, previous)| previous != sha256)
        {
            return Err("Host package metadata changed during one generation".into());
        }
        let mut strong = labels.files.contains_key(&key);
        for path in [requested, resolved] {
            for guest in &labels.guest_namespaces {
                if equivalent_path(guest, path)? {
                    return Err("Host and Guest package metadata namespace conflict".into());
                }
            }
            for (previous, identity) in &labels.metadata_namespaces {
                if equivalent_path(previous, path)? && *identity != key {
                    return Err("Host package metadata namespace changed".into());
                }
            }
            for previous in &labels.namespaces {
                strong |= equivalent_path(previous, path)?;
            }
        }
        for (device, inode, previous) in labels.guest_slots.keys() {
            if (*device, *inode) == (directory.dev(), directory.ino())
                && equivalent_name(previous, name)?
            {
                return Err("Host and Guest package metadata slot conflict".into());
            }
        }
        for (device, inode, previous) in &labels.audit_slots {
            if (*device, *inode) == (directory.dev(), directory.ino())
                && equivalent_name(previous, name)?
            {
                return Err("Audit slot cannot be package metadata".into());
            }
        }
        for ((device, inode, previous), slot) in &labels.metadata_slots {
            if (*device, *inode) == (directory.dev(), directory.ino())
                && equivalent_name(previous, name)?
                && slot.identity != key
            {
                return Err("Host package metadata slot changed".into());
            }
        }
        for (device, inode, previous) in labels.slots.keys() {
            if (*device, *inode) == (directory.dev(), directory.ino()) {
                strong |= equivalent_name(previous, name)?;
            }
        }
        // A previously strong private source remains strong; a metadata probe
        // cannot downgrade it or grant a Guest metadata exception.
        if strong {
            return Ok(false);
        }
        let mut paths = vec![requested.to_path_buf()];
        if requested != resolved {
            paths.push(resolved.to_path_buf());
        }
        let needed = usize::from(!labels.metadata_files.contains_key(&key))
            + usize::from(!labels.metadata_slots.contains_key(&slot))
            + paths
                .iter()
                .filter(|path| !labels.metadata_namespaces.contains_key(path.as_path()))
                .count();
        if labels.len() + needed > Self::LIMIT {
            return Err("Source identity limit exceeded; restart required".into());
        }
        let file_pin = file
            .try_clone()
            .map_err(|_| "Cannot pin package metadata identity")?;
        let parent_pin = parent
            .try_clone()
            .map_err(|_| "Cannot pin package metadata directory")?;
        labels
            .metadata_files
            .entry(key)
            .or_insert((file_pin, sha256.to_owned()));
        labels.metadata_slots.entry(slot).or_insert(MetadataSlot {
            identity: key,
            _parent: parent_pin,
        });
        for path in paths {
            labels.metadata_namespaces.entry(path).or_insert(key);
        }
        Ok(true)
    }
    pub(crate) fn reserve_missing_package_metadata(
        &self,
        requested: &Path,
        resolved: &Path,
        parent: Option<&File>,
        name: Option<&std::ffi::OsStr>,
    ) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        if requested.file_name() != Some(std::ffi::OsStr::new("package.json"))
            || resolved.file_name() != Some(std::ffi::OsStr::new("package.json"))
        {
            return Err("Invalid missing package metadata name".into());
        }
        let mut labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        let mut paths = vec![requested.to_path_buf()];
        if requested != resolved {
            paths.push(resolved.to_path_buf());
        }
        for path in &paths {
            for guest in &labels.guest_namespaces {
                if equivalent_path(guest, path)? {
                    return Err("Host and Guest package metadata namespace conflict".into());
                }
            }
        }
        let slot = if let (Some(parent), Some(name)) = (parent, name) {
            let metadata = parent
                .metadata()
                .map_err(|_| "Source directory unavailable")?;
            let slot = (metadata.dev(), metadata.ino(), name.to_os_string());
            for (device, inode, previous) in labels.guest_slots.keys() {
                if (*device, *inode) == (metadata.dev(), metadata.ino())
                    && equivalent_name(previous, name)?
                {
                    return Err("Host and Guest package metadata slot conflict".into());
                }
            }
            Some((
                slot,
                parent
                    .try_clone()
                    .map_err(|_| "Cannot pin package metadata directory")?,
            ))
        } else {
            None
        };
        let needed = paths
            .iter()
            .filter(|path| !labels.metadata_missing_namespaces.contains(path.as_path()))
            .count()
            + usize::from(
                slot.as_ref()
                    .is_some_and(|(key, _)| !labels.metadata_missing_slots.contains_key(key)),
            );
        if labels.len() + needed > Self::LIMIT {
            return Err("Source identity limit exceeded; restart required".into());
        }
        labels.metadata_missing_namespaces.extend(paths);
        if let Some((key, parent)) = slot {
            labels.metadata_missing_slots.entry(key).or_insert(parent);
        }
        Ok(())
    }
    fn check_metadata_namespace(
        &self,
        path: &Path,
        purpose: SourceReadPurpose,
    ) -> Result<(), String> {
        let labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        if purpose == SourceReadPurpose::Module {
            for previous in labels.metadata_namespaces.keys() {
                if equivalent_path(previous, path)? {
                    return Err("Host package metadata is not Guest source".into());
                }
            }
            for previous in &labels.metadata_missing_namespaces {
                if equivalent_path(previous, path)? {
                    return Err("Host package metadata is not Guest source".into());
                }
            }
        }
        Ok(())
    }
    fn check_metadata_slot(
        &self,
        parent: &File,
        name: &std::ffi::OsStr,
        purpose: SourceReadPurpose,
    ) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        if purpose != SourceReadPurpose::Module {
            return Ok(());
        }
        let metadata = parent
            .metadata()
            .map_err(|_| "Source directory unavailable")?;
        let labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        for (device, inode, previous) in labels.metadata_slots.keys() {
            if (*device, *inode) == (metadata.dev(), metadata.ino())
                && equivalent_name(previous, name)?
            {
                return Err("Host package metadata is not Guest source".into());
            }
        }
        for (device, inode, previous) in labels.metadata_missing_slots.keys() {
            if (*device, *inode) == (metadata.dev(), metadata.ino())
                && equivalent_name(previous, name)?
            {
                return Err("Host package metadata is not Guest source".into());
            }
        }
        Ok(())
    }
    fn guest_metadata_digest(
        &self,
        file: &File,
        path: &Path,
        parent: &File,
        name: &std::ffi::OsStr,
        sha256: &str,
    ) -> Result<bool, String> {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata().map_err(|_| "Source identity unavailable")?;
        let directory = parent
            .metadata()
            .map_err(|_| "Source directory unavailable")?;
        let key = (metadata.dev(), metadata.ino());
        let labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        if labels.files.get(&key).is_some_and(|(host, _)| *host)
            || labels.audit_files.contains(&key)
        {
            return Err("Private source identity".into());
        }
        for (previous, identity) in &labels.metadata_namespaces {
            if equivalent_path(previous, path)? && *identity != key {
                return Err("Host package metadata namespace changed".into());
            }
        }
        for previous in &labels.metadata_missing_namespaces {
            if equivalent_path(previous, path)? && !labels.metadata_files.contains_key(&key) {
                return Err("Unadmitted replacement of missing package metadata".into());
            }
        }
        for ((device, inode, previous), slot) in &labels.metadata_slots {
            if (*device, *inode) == (directory.dev(), directory.ino())
                && equivalent_name(previous, name)?
                && slot.identity != key
            {
                return Err("Host package metadata slot changed".into());
            }
        }
        for (device, inode, previous) in labels.metadata_missing_slots.keys() {
            if (*device, *inode) == (directory.dev(), directory.ino())
                && equivalent_name(previous, name)?
                && !labels.metadata_files.contains_key(&key)
            {
                return Err("Unadmitted replacement of missing package metadata".into());
            }
        }
        if let Some((_, expected)) = labels.metadata_files.get(&key) {
            if expected != sha256 {
                return Err("Host package metadata changed during one generation".into());
            }
            return Ok(true);
        }
        Ok(false)
    }
    fn check_namespace(&self, path: &Path) -> Result<(), String> {
        let labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        for private in labels.private_directories.keys() {
            if equivalent_path_prefix(private, path)? {
                return Err("Private source directory".into());
            }
        }
        for private in &labels.namespaces {
            if equivalent_path(private, path)? {
                return Err("Private source namespace".into());
            }
        }
        Ok(())
    }
    fn guest_namespace(&self, path: &Path) -> Result<(), String> {
        let mut labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        for private in labels.private_directories.keys() {
            if equivalent_path_prefix(private, path)? {
                return Err("Private source directory".into());
            }
        }
        for private in &labels.namespaces {
            if equivalent_path(private, path)? {
                return Err("Private source namespace".into());
            }
        }
        if !labels.guest_namespaces.contains(path) {
            if labels.len() >= Self::LIMIT {
                return Err("Source identity limit exceeded; restart required".into());
            }
            labels.guest_namespaces.insert(path.into());
        }
        Ok(())
    }
    fn check_slot(&self, parent: &File, name: &std::ffi::OsStr) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        self.check_private_directory_identity(parent)?;
        let metadata = parent
            .metadata()
            .map_err(|_| "Source directory unavailable")?;
        let labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        for (device, inode, private_name) in labels.slots.keys() {
            if (*device, *inode) == (metadata.dev(), metadata.ino())
                && equivalent_name(private_name, name)?
            {
                return Err("Private source namespace".into());
            }
        }
        Ok(())
    }
    fn guest_probe(&self, file: &File) -> Result<(), String> {
        // Supplemental discovery of CURRENT hard links. Namespace rejection is
        // performed BEFORE opening Guest files; this scan is not an atomic
        // namespace check and cannot reconstruct unobserved external history.
        let replacements = {
            let labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
            let mut files = Vec::new();
            for path in &labels.namespaces {
                if labels.private_directories.contains_key(path) {
                    continue;
                }
                // Mirror HostConfiguration's path observation (nofollow leaf,
                // ordinary OS ancestor lookup), including an ancestor rebind.
                // This discovers identities only; Guest traversal remains
                // descriptor-confined and never follows symlinks.
                use std::os::unix::fs::OpenOptionsExt;
                let current = std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
                    .open(path);
                match current {
                    Ok(file) => files.push(file),
                    Err(error)
                        if matches!(
                            error.raw_os_error(),
                            Some(libc::ENOENT | libc::ENOTDIR | libc::ELOOP)
                        ) => {}
                    Err(_) => return Err("Private source namespace unavailable".into()),
                }
            }
            for ((_, _, name), parent) in &labels.slots {
                match open_confined(parent, Path::new(name)) {
                    Ok(file) => files.push(file),
                    Err(error)
                        if matches!(
                            error.raw_os_error(),
                            Some(libc::ENOENT | libc::ENOTDIR | libc::ELOOP)
                        ) => {}
                    Err(_) => return Err("Private source slot unavailable".into()),
                }
            }
            files
        };
        for replacement in replacements {
            use std::os::unix::fs::MetadataExt;
            let metadata = replacement
                .metadata()
                .map_err(|_| "Private source identity unavailable")?;
            if metadata.is_dir() {
                let labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
                let known_private_directory =
                    labels.private_directories.values().flatten().any(|pinned| {
                        pinned.metadata().is_ok_and(|previous| {
                            (previous.dev(), previous.ino()) == (metadata.dev(), metadata.ino())
                        })
                    });
                if known_private_directory {
                    continue;
                }
            }
            let known_audit = self
                .0
                .lock()
                .map_err(|_| "Source admission unavailable")?
                .audit_files
                .contains(&(metadata.dev(), metadata.ino()));
            // Discovery retains the existing private audit role; it must not
            // attempt to promote that identity to executable Host source.
            if !known_audit {
                self.host(&replacement)?;
            }
        }
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata().map_err(|_| "Source identity unavailable")?;
        let labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        if labels
            .audit_files
            .contains(&(metadata.dev(), metadata.ino()))
            || labels
                .files
                .get(&(metadata.dev(), metadata.ino()))
                .is_some_and(|(host, _)| *host)
        {
            return Err("Private source identity".into());
        }
        Ok(())
    }
    fn guest(&self, file: &File) -> Result<(), String> {
        self.guest_probe(file)?;
        self.admit(file, false)
    }
    fn guest_source(
        &self,
        path: &Path,
        parent: &File,
        name: &std::ffi::OsStr,
        file: &File,
    ) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        self.guest(file)?;
        let metadata = parent
            .metadata()
            .map_err(|_| "Source directory unavailable")?;
        let key = (metadata.dev(), metadata.ino(), name.to_os_string());
        let mut labels = self.0.lock().map_err(|_| "Source admission unavailable")?;
        for private in &labels.namespaces {
            if equivalent_path(private, path)? {
                return Err("Private source namespace".into());
            }
        }
        for private in labels.private_directories.keys() {
            if equivalent_path_prefix(private, path)? {
                return Err("Private source directory".into());
            }
        }
        for (device, inode, private_name) in labels.slots.keys() {
            if (*device, *inode) == (metadata.dev(), metadata.ino())
                && equivalent_name(private_name, name)?
            {
                return Err("Private source namespace".into());
            }
        }
        let needed = usize::from(!labels.guest_namespaces.contains(path))
            + usize::from(!labels.guest_slots.contains_key(&key));
        if labels.len() + needed > Self::LIMIT {
            return Err("Source identity limit exceeded; restart required".into());
        }
        if needed != 0 {
            let pin = parent
                .try_clone()
                .map_err(|_| "Cannot pin source directory")?;
            labels.guest_namespaces.insert(path.into());
            labels.guest_slots.entry(key).or_insert(pin);
        }
        Ok(())
    }
    pub fn capture(&self, path: &Path, file: &File) -> Result<PrivateSource, String> {
        use std::os::unix::fs::MetadataExt;
        self.host(file)?;
        self.reserve_namespace(path)?;
        let parent_path = path.parent().ok_or("Invalid private source path")?;
        let root = File::open("/").map_err(|_| "Source root unavailable")?;
        let parent = if parent_path == Path::new("/") {
            root
        } else {
            open_confined(
                &root,
                parent_path
                    .strip_prefix("/")
                    .map_err(|_| "Invalid private source path")?,
            )
            .map_err(|_| "Private source directory unavailable")?
        };
        self.host_slot(
            &parent,
            path.file_name().ok_or("Invalid private source path")?,
        )?;
        let metadata = file.metadata().map_err(|_| "Source identity unavailable")?;
        Ok(PrivateSource {
            path: path.to_path_buf(),
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    pub fn restore(&self, bindings: &[PrivateSource]) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        if bindings.len() > Self::LIMIT {
            return Err("Private source limit exceeded".into());
        }
        for binding in bindings {
            if !binding.path.is_absolute() {
                return Err("Invalid private source path".into());
            }
            let file = open_confined(
                &File::open("/").map_err(|_| "Source root unavailable")?,
                binding
                    .path
                    .strip_prefix("/")
                    .map_err(|_| "Invalid private source path")?,
            )
            .map_err(|_| "Private source unavailable or not confined")?;
            let metadata = file.metadata().map_err(|_| "Source identity unavailable")?;
            if (metadata.dev(), metadata.ino()) != (binding.device, binding.inode) {
                return Err("Private source identity changed before launch".into());
            }
            self.capture(&binding.path, &file)?;
        }
        Ok(())
    }
}

/// Runtime source reads are immutable and confined to an opened workspace root.
pub struct SourceStore {
    #[cfg(test)]
    after_open: Option<Box<dyn FnOnce()>>,
    admission: SourceAdmission,
    root: File,
    root_path: PathBuf,
    pub entry_url: String,
    snapshots: HashMap<String, String>,
    strict_metadata_only: HashSet<String>,
    strict_identities: HashMap<String, (u64, u64)>,
    resource_snapshots: HashMap<String, Arc<SourceResource>>,
    canonical_resources: HashMap<String, Arc<SourceResource>>,
    resource_identities: HashMap<String, (u64, u64)>,
    aliases: HashMap<String, String>,
    allowed_urls: Option<HashSet<String>>,
    metadata_only_paths: Option<HashSet<PathBuf>>,
    total_bytes: usize,
}

impl SourceStore {
    pub(crate) fn pinned_root(&self) -> (&Path, &File) {
        (&self.root_path, &self.root)
    }

    pub fn new(entry: &Path) -> Result<Self, String> {
        Self::with_admission(entry, SourceAdmission::default())
    }
    pub fn with_admission(entry: &Path, admission: SourceAdmission) -> Result<Self, String> {
        let entry = entry
            .canonicalize()
            .map_err(|_| "Entry file is unavailable")?;
        if !entry.is_file() {
            return Err("Entry must be a regular file".into());
        }
        let root = File::open(entry.parent().ok_or("Entry has no parent")?)
            .map_err(|_| "Cannot open workspace")?;
        let mut url = Url::parse("app://workspace/").unwrap();
        url.path_segments_mut().unwrap().push(
            entry
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("Entry must be UTF-8")?,
        );
        Ok(Self {
            #[cfg(test)]
            after_open: None,
            admission,
            root,
            root_path: entry.parent().ok_or("Entry has no parent")?.into(),
            entry_url: url.to_string(),
            snapshots: HashMap::new(),
            strict_metadata_only: HashSet::new(),
            strict_identities: HashMap::new(),
            resource_snapshots: HashMap::new(),
            canonical_resources: HashMap::new(),
            resource_identities: HashMap::new(),
            aliases: HashMap::new(),
            allowed_urls: None,
            metadata_only_paths: None,
            total_bytes: 0,
        })
    }

    /// A trusted Host caller may select a workspace root without an entry file.
    /// The opened root stays pinned for every later Guest URL traversal.
    pub fn with_workspace_root(root: &Path, admission: SourceAdmission) -> Result<Self, String> {
        let root_path = root
            .canonicalize()
            .map_err(|_| "Workspace root is unavailable")?;
        if !root_path.is_dir() {
            return Err("Workspace root must be a directory".into());
        }
        let anchor = File::open("/").map_err(|_| "Source root unavailable")?;
        let root = if root_path == Path::new("/") {
            anchor
        } else {
            open_confined(
                &anchor,
                root_path
                    .strip_prefix("/")
                    .map_err(|_| "Invalid workspace root")?,
            )
            .map_err(|_| "Workspace root is unavailable or not confined")?
        };
        if !root
            .metadata()
            .map_err(|_| "Workspace root is unavailable")?
            .is_dir()
        {
            return Err("Workspace root must be a directory".into());
        }
        Ok(Self {
            #[cfg(test)]
            after_open: None,
            admission,
            root,
            root_path,
            entry_url: "app://workspace/".into(),
            snapshots: HashMap::new(),
            strict_metadata_only: HashSet::new(),
            strict_identities: HashMap::new(),
            resource_snapshots: HashMap::new(),
            canonical_resources: HashMap::new(),
            resource_identities: HashMap::new(),
            aliases: HashMap::new(),
            allowed_urls: None,
            metadata_only_paths: None,
            total_bytes: 0,
        })
    }

    /// Select an actual entry within an explicit, pinned workspace root.
    /// Validation does not read or label Guest source before private admission.
    pub fn with_workspace_entry(
        workspace_root: &Path,
        entry: &Path,
        admission: SourceAdmission,
    ) -> Result<Self, String> {
        if !entry.is_absolute() {
            return Err("Entry must be absolute".into());
        }
        let mut store = Self::with_workspace_root(workspace_root, admission)?;
        let entry = entry
            .canonicalize()
            .map_err(|_| "Entry file is unavailable")?;
        let relative = entry
            .strip_prefix(&store.root_path)
            .map_err(|_| "Entry is outside the workspace")?;
        if relative.as_os_str().is_empty() {
            return Err("Entry must be a regular file".into());
        }
        let file = open_confined(&store.root, relative)
            .map_err(|_| "Entry is unavailable or not confined")?;
        if !file
            .metadata()
            .map_err(|_| "Entry file is unavailable")?
            .is_file()
        {
            return Err("Entry must be a regular file".into());
        }
        let mut url = Url::parse("app://workspace/").unwrap();
        {
            let mut segments = url.path_segments_mut().unwrap();
            for component in relative.components() {
                let Component::Normal(name) = component else {
                    return Err("Entry is outside the workspace".into());
                };
                segments.push(name.to_str().ok_or("Entry must be UTF-8")?);
            }
        }
        store.entry_url = url.to_string();
        Ok(store)
    }

    pub fn restrict_to_urls(&mut self, urls: Vec<String>) -> Result<(), String> {
        if self.allowed_urls.is_some()
            || !self.snapshots.is_empty()
            || !self.resource_snapshots.is_empty()
            || urls.is_empty()
            || urls.len() > MAX_MODULES * 2
            || urls.iter().map(String::len).sum::<usize>() > 512 * 1024
        {
            return Err("Invalid source snapshot allowlist".into());
        }
        let mut allowed = HashSet::new();
        for value in urls {
            if !valid_module_url(&value) || !allowed.insert(value) {
                return Err("Invalid source snapshot URL".into());
            }
        }
        if !allowed.contains(&self.entry_url) {
            return Err("Source snapshot entry is unavailable".into());
        }
        self.allowed_urls = Some(allowed);
        Ok(())
    }

    /// Version 4's owner-selected physical staging paths. URL query and
    /// logical aliases never remove the restriction on these files.
    pub fn restrict_metadata_only(&mut self, urls: Vec<String>) -> Result<(), String> {
        let Some(allowed) = self.allowed_urls.as_ref() else {
            return Err("Package metadata restrictions require a source allowlist".into());
        };
        if self.metadata_only_paths.is_some()
            || !self.snapshots.is_empty()
            || !self.resource_snapshots.is_empty()
            || urls.is_empty()
            || urls.len() > MAX_MODULES
            || urls.iter().map(String::len).sum::<usize>() > 256 * 1024
        {
            return Err("Invalid package metadata restrictions".into());
        }
        let mut paths = HashSet::<PathBuf>::new();
        for value in urls {
            let (url, relative) = module_relative(&value)?;
            if !valid_module_url(&value)
                || url.query().is_some()
                || url.fragment().is_some()
                || relative.file_name() != Some(std::ffi::OsStr::new("package.json"))
                || !allowed.contains(&value)
            {
                return Err("Invalid package metadata URL".into());
            }
            for previous in &paths {
                if equivalent_path(previous, &relative)? {
                    return Err("Duplicate physical package metadata path".into());
                }
            }
            paths.insert(relative);
        }
        self.metadata_only_paths = Some(paths);
        Ok(())
    }

    fn is_metadata_only_path(&self, relative: &Path) -> Result<bool, String> {
        let Some(paths) = &self.metadata_only_paths else {
            return Ok(false);
        };
        if paths.contains(relative) {
            return Ok(true);
        }
        for previous in paths {
            if equivalent_path(previous, relative)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn install_aliases(&mut self, aliases: Vec<ModuleAlias>) -> Result<(), String> {
        let Some(allowed) = self.allowed_urls.as_ref() else {
            return Err("Module aliases require a source allowlist".into());
        };
        if !self.snapshots.is_empty()
            || !self.resource_snapshots.is_empty()
            || !self.aliases.is_empty()
            || aliases.is_empty()
            || aliases.len() > MAX_MODULES
            || allowed.len().saturating_sub(aliases.len()) > MAX_MODULES
            || aliases
                .iter()
                .map(|alias| alias.url.len() + alias.canonical_url.len())
                .sum::<usize>()
                > 256 * 1024
        {
            return Err("Invalid module aliases".into());
        }
        let keys = aliases
            .iter()
            .map(|alias| alias.url.clone())
            .collect::<HashSet<_>>();
        if keys.len() != aliases.len() {
            return Err("Invalid module aliases".into());
        }
        for alias in &aliases {
            if !valid_module_url(&alias.url)
                || !valid_module_url(&alias.canonical_url)
                || alias.url == alias.canonical_url
                || keys.contains(&alias.canonical_url)
                || Url::parse(&alias.url)
                    .ok()
                    .and_then(|url| url.query().map(str::to_owned))
                    != Url::parse(&alias.canonical_url)
                        .ok()
                        .and_then(|url| url.query().map(str::to_owned))
                || Url::parse(&alias.url)
                    .ok()
                    .and_then(|url| url.fragment().map(str::to_owned))
                    != Url::parse(&alias.canonical_url)
                        .ok()
                        .and_then(|url| url.fragment().map(str::to_owned))
                || !allowed.contains(&alias.url)
                || !allowed.contains(&alias.canonical_url)
            {
                return Err("Invalid module aliases".into());
            }
        }
        self.aliases = aliases
            .into_iter()
            .map(|alias| (alias.url, alias.canonical_url))
            .collect();
        Ok(())
    }

    pub fn read(&mut self, input: &str) -> Result<Option<String>, String> {
        self.read_with_purpose(input, SourceReadPurpose::Module)
    }

    pub fn read_with_purpose(
        &mut self,
        input: &str,
        purpose: SourceReadPurpose,
    ) -> Result<Option<String>, String> {
        if self
            .allowed_urls
            .as_ref()
            .is_some_and(|urls| !urls.contains(input))
        {
            return Ok(None);
        }
        let target = self
            .aliases
            .get(input)
            .cloned()
            .unwrap_or_else(|| input.into());
        if target != input {
            if self
                .allowed_urls
                .as_ref()
                .is_some_and(|urls| !urls.contains(&target))
            {
                return Ok(None);
            }
            let (_, requested) = module_relative(input)?;
            self.admission
                .check_metadata_namespace(&self.root_path.join(&requested), purpose)?;
            if purpose == SourceReadPurpose::Module {
                self.admission
                    .guest_namespace(&self.root_path.join(requested))?;
            }
        }
        self.read_strict(&target, purpose)
    }

    fn read_strict(
        &mut self,
        input: &str,
        purpose: SourceReadPurpose,
    ) -> Result<Option<String>, String> {
        if self
            .allowed_urls
            .as_ref()
            .is_some_and(|urls| !urls.contains(input))
        {
            return Ok(None);
        }
        let url = Url::parse(input).map_err(|_| "Invalid module URL")?;
        if url.scheme() != "app"
            || url.host_str() != Some("workspace")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return Err("Module is outside the workspace".into());
        }
        let mut file_url = Url::parse("file:///").unwrap();
        file_url.set_path(url.path());
        let path = file_url.to_file_path().map_err(|_| "Invalid module path")?;
        let relative: PathBuf = path
            .strip_prefix("/")
            .map_err(|_| "Invalid module path")?
            .into();
        let mut canonical = Url::parse("app://workspace/").unwrap();
        {
            let mut segments = canonical.path_segments_mut().unwrap();
            for component in relative.components() {
                if let Component::Normal(name) = component {
                    segments.push(name.to_str().ok_or("Invalid module path encoding")?);
                } else {
                    return Err("Invalid module path".into());
                }
            }
        }
        if canonical.path() != url.path() {
            return Err("Module path is not canonically encoded".into());
        }
        if purpose == SourceReadPurpose::PackageMetadata
            && (url.query().is_some()
                || url.fragment().is_some()
                || relative.file_name() != Some(std::ffi::OsStr::new("package.json")))
        {
            return Err("Package metadata purpose requires exact package.json".into());
        }
        // This decision depends on the requested namespace, not on whichever
        // replacement inode happens to be present after open. It therefore
        // survives directory rebinding and A -> B -> C leaf replacement.
        self.admission
            .check_namespace(&self.root_path.join(&relative))?;
        self.admission
            .check_metadata_namespace(&self.root_path.join(&relative), purpose)?;
        if purpose == SourceReadPurpose::Module && self.is_metadata_only_path(&relative)? {
            return Err("Package metadata is not module source".into());
        }
        if let Some(source) = self.snapshots.get(input) {
            if purpose == SourceReadPurpose::Module && self.strict_metadata_only.contains(input) {
                return Err("Package metadata is not module source".into());
            }
            if !self.strict_metadata_only.contains(input) {
                return Ok(Some(source.clone()));
            }
        }
        let mut guest_slot = None;
        let file = match open_confined_before_leaf(&self.root, &relative, |parent, name, leaf| {
            self.admission
                .check_private_directory_identity(parent)
                .map_err(|_| std::io::ErrorKind::PermissionDenied)?;
            if leaf {
                self.admission
                    .check_slot(parent, name)
                    .map_err(|_| std::io::ErrorKind::PermissionDenied)?;
                self.admission
                    .check_metadata_slot(parent, name, purpose)
                    .map_err(|_| std::io::ErrorKind::PermissionDenied)?;
                guest_slot = Some((parent.try_clone()?, name.to_os_string()));
            }
            Ok(())
        }) {
            Ok(file) => file,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                return Ok(None);
            }
            Err(_) => return Err("Module path is unavailable or not confined".into()),
        };
        #[cfg(test)]
        if let Some(after_open) = self.after_open.take() {
            after_open();
        }
        let metadata = file.metadata().map_err(|_| "Cannot inspect module")?;
        if purpose == SourceReadPurpose::Module && metadata.is_dir() {
            self.admission.check_private_directory_identity(&file)?;
            return Ok(None);
        }
        if !metadata.is_file() || metadata.len() > MAX_MODULE_BYTES {
            return Err("Module is not a bounded regular file".into());
        }
        let (parent, name) = guest_slot.ok_or("Module parent is unavailable")?;
        let mut bytes = Vec::new();
        (&file)
            .take(MAX_MODULE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read module")?;
        if bytes.len() as u64 > MAX_MODULE_BYTES
            || (!self.snapshots.contains_key(input)
                && (self.total_bytes + bytes.len() > MAX_GRAPH_BYTES
                    || self.snapshots.len() >= MAX_MODULES))
        {
            return Err("Module graph limit exceeded".into());
        }
        std::str::from_utf8(&bytes).map_err(|_| "Module must be valid UTF-8")?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        self.admission.guest_probe(&file)?;
        let weak = if purpose == SourceReadPurpose::PackageMetadata {
            self.admission.guest_metadata_digest(
                &file,
                &self.root_path.join(&relative),
                &parent,
                &name,
                &sha256,
            )?
        } else {
            false
        };
        let flagged = self.is_metadata_only_path(&relative)?;
        let metadata_only = weak || flagged;
        if !metadata_only {
            self.admission
                .guest_source(&self.root_path.join(&relative), &parent, &name, &file)?;
        }
        let result = if metadata_only {
            json!({"sha256": sha256, "bytes": bytes, "metadataOnly": true}).to_string()
        } else {
            json!({"sha256": sha256, "bytes": bytes}).to_string()
        };
        use std::os::unix::fs::MetadataExt;
        let identity = (metadata.dev(), metadata.ino());
        if let Some(previous) = self.snapshots.get(input) {
            if previous != &result || self.strict_identities.get(input) != Some(&identity) {
                return Err("Module source changed under one identity".into());
            }
            return Ok(Some(previous.clone()));
        }
        self.total_bytes += bytes.len();
        self.strict_identities.insert(input.into(), identity);
        self.snapshots.insert(input.into(), result.clone());
        if metadata_only {
            self.strict_metadata_only.insert(input.into());
        }
        Ok(Some(result))
    }

    /// Source-only helper read. The resolved URL is derived from the same
    /// descriptor walk that opens the bytes, never from a prior realpath walk.
    /// Ordinary `read` intentionally retains its nofollow behavior.
    pub fn read_resource(&mut self, input: &str) -> Result<Option<Arc<SourceResource>>, String> {
        self.read_resource_with_purpose(input, SourceReadPurpose::Module)
    }

    pub fn read_resource_with_purpose(
        &mut self,
        input: &str,
        purpose: SourceReadPurpose,
    ) -> Result<Option<Arc<SourceResource>>, String> {
        use std::os::unix::fs::MetadataExt;
        if self
            .allowed_urls
            .as_ref()
            .is_some_and(|urls| !urls.contains(input))
        {
            return Ok(None);
        }
        if !valid_module_url(input) {
            return Err("Invalid module URL".into());
        }
        let (url, requested) = module_relative(input)?;
        if purpose == SourceReadPurpose::PackageMetadata
            && (url.query().is_some()
                || url.fragment().is_some()
                || requested.file_name() != Some(std::ffi::OsStr::new("package.json")))
        {
            return Err("Package metadata purpose requires exact package.json".into());
        }
        self.admission
            .check_namespace(&self.root_path.join(&requested))?;
        self.admission
            .check_metadata_namespace(&self.root_path.join(&requested), purpose)?;
        let target = self
            .aliases
            .get(input)
            .cloned()
            .unwrap_or_else(|| input.into());
        if self
            .allowed_urls
            .as_ref()
            .is_some_and(|urls| !urls.contains(&target))
        {
            return Ok(None);
        }
        let (_, target_relative) = module_relative(&target)?;
        self.admission
            .check_namespace(&self.root_path.join(&target_relative))?;
        self.admission
            .check_metadata_namespace(&self.root_path.join(&target_relative), purpose)?;
        if let Some(resource) = self.resource_snapshots.get(input) {
            if self
                .allowed_urls
                .as_ref()
                .is_some_and(|urls| !urls.contains(&resource.canonical_url))
            {
                return Ok(None);
            }
            let (_, resolved) = module_relative(&resource.canonical_url)?;
            self.admission
                .check_namespace(&self.root_path.join(&resolved))?;
            self.admission
                .check_metadata_namespace(&self.root_path.join(&resolved), purpose)?;
            if purpose == SourceReadPurpose::Module
                && (resource.metadata_only || self.is_metadata_only_path(&resolved)?)
            {
                return Err("Package metadata is not module source".into());
            }
            if !resource.metadata_only {
                return Ok(Some(resource.clone()));
            }
        }
        let (file, resolved, parent, name) = match open_package_source(
            &self.root,
            &self.root_path,
            &target_relative,
            PackageWalkRole::Guest {
                query: url.query(),
                fragment: url.fragment(),
                admission: &self.admission,
                allowed: self.allowed_urls.as_ref(),
                purpose,
            },
        )? {
            PackageWalk::Found(file, resolved, parent, name) => (file, resolved, parent, name),
            PackageWalk::Missing(_, _, _) | PackageWalk::OutsideAllowlist => return Ok(None),
        };
        #[cfg(test)]
        if let Some(after_open) = self.after_open.take() {
            after_open();
        }
        let canonical_url = module_url(&resolved, url.query(), url.fragment())?;
        if target != input && canonical_url != target {
            return Err("Module alias target changed".into());
        }
        self.admission
            .check_metadata_namespace(&self.root_path.join(&resolved), purpose)?;
        let flagged = self.is_metadata_only_path(&resolved)?;
        if purpose == SourceReadPurpose::Module && flagged {
            return Err("Package metadata is not module source".into());
        }
        let metadata = file.metadata().map_err(|_| "Cannot inspect module")?;
        if purpose == SourceReadPurpose::Module && metadata.is_dir() {
            self.admission.check_private_directory_identity(&file)?;
            return Ok(None);
        }
        if !metadata.is_file() || metadata.len() > MAX_MODULE_BYTES {
            return Err("Module is not a bounded regular file".into());
        }
        let mut bytes = Vec::new();
        (&file)
            .take(MAX_MODULE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read module")?;
        if bytes.len() as u64 > MAX_MODULE_BYTES {
            return Err("Module graph limit exceeded".into());
        }
        std::str::from_utf8(&bytes).map_err(|_| "Module must be valid UTF-8")?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        self.admission.guest_probe(&file)?;
        let weak = if purpose == SourceReadPurpose::PackageMetadata {
            let requested_weak = self.admission.guest_metadata_digest(
                &file,
                &self.root_path.join(&requested),
                &parent,
                &name,
                &sha256,
            )?;
            let resolved_weak = if requested != resolved {
                self.admission.guest_metadata_digest(
                    &file,
                    &self.root_path.join(&resolved),
                    &parent,
                    &name,
                    &sha256,
                )?
            } else {
                false
            };
            requested_weak || resolved_weak
        } else {
            false
        };
        let metadata_only = weak || flagged;
        if !metadata_only {
            self.admission
                .guest_source(&self.root_path.join(&requested), &parent, &name, &file)?;
            if requested != resolved {
                self.admission.guest_source(
                    &self.root_path.join(&resolved),
                    &parent,
                    &name,
                    &file,
                )?;
            }
        }
        let identity = (metadata.dev(), metadata.ino());
        if let Some(resource) = self.canonical_resources.get(&canonical_url).cloned() {
            if self.resource_identities.get(&canonical_url) != Some(&identity)
                || resource.sha256 != sha256
                || resource.bytes != bytes
                || resource.metadata_only != metadata_only
            {
                return Err("Module resource changed under one canonical identity".into());
            }
            if self.resource_snapshots.len() >= MAX_MODULES * 2 {
                return Err("Module graph limit exceeded".into());
            }
            self.resource_snapshots
                .insert(input.into(), resource.clone());
            return Ok(Some(resource));
        }
        if self.resource_snapshots.len() >= MAX_MODULES * 2
            || self.canonical_resources.len() >= MAX_MODULES
            || self.total_bytes + bytes.len() > MAX_GRAPH_BYTES
        {
            return Err("Module graph limit exceeded".into());
        }
        let resource = Arc::new(SourceResource {
            sha256,
            bytes,
            canonical_url: canonical_url.clone(),
            metadata_only,
        });
        self.total_bytes += resource.bytes.len();
        self.resource_identities
            .insert(canonical_url.clone(), identity);
        self.canonical_resources
            .insert(canonical_url, resource.clone());
        self.resource_snapshots
            .insert(input.into(), resource.clone());
        Ok(Some(resource))
    }
}

fn valid_module_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    value.len() <= 4096
        && url.as_str() == value
        && url.scheme() == "app"
        && url.host_str() == Some("workspace")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none_or(str::is_empty)
        && module_relative(value).is_ok()
}

fn module_relative(input: &str) -> Result<(Url, PathBuf), String> {
    let url = Url::parse(input).map_err(|_| "Invalid module URL")?;
    if url.scheme() != "app"
        || url.host_str() != Some("workspace")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("Module is outside the workspace".into());
    }
    let mut file_url = Url::parse("file:///").unwrap();
    file_url.set_path(url.path());
    let path = file_url.to_file_path().map_err(|_| "Invalid module path")?;
    let relative: PathBuf = path
        .strip_prefix("/")
        .map_err(|_| "Invalid module path")?
        .into();
    if Url::parse(&module_url(&relative, None, None)?)
        .map_err(|_| "Invalid module path")?
        .path()
        != url.path()
    {
        return Err("Module path is not canonically encoded".into());
    }
    Ok((url, relative))
}

fn module_url(
    relative: &Path,
    query: Option<&str>,
    fragment: Option<&str>,
) -> Result<String, String> {
    let mut url = Url::parse("app://workspace/").unwrap();
    {
        let mut segments = url.path_segments_mut().unwrap();
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err("Invalid module path".into());
            };
            segments.push(name.to_str().ok_or("Invalid module path encoding")?);
        }
    }
    url.set_query(query);
    url.set_fragment(fragment);
    Ok(url.into())
}

/// A Host-only resource root uses the same confined package-directory walker
/// as Guest sources. It never resolves JavaScript specifiers; the shared
/// Module Loader selects each requested virtual URL.
#[derive(Debug)]
pub struct PrivateSourceRoot {
    root: File,
    root_path: PathBuf,
    root_url: String,
    admission: SourceAdmission,
    packages: Vec<PrivateSourcePackage>,
    requested: HashMap<String, Arc<SourceResource>>,
    canonical: HashMap<String, (Arc<SourceResource>, (u64, u64))>,
    weak_canonical: HashSet<String>,
    total_bytes: usize,
    expected: Option<HashMap<String, (usize, String)>>,
    aliases: HashMap<String, String>,
    budget: Arc<Mutex<PrivateResourceBudget>>,
    seeded_hashes: HashMap<PathBuf, String>,
}

#[derive(Debug)]
struct PrivateSourcePackage {
    requested_root: PathBuf,
    canonical_root: PathBuf,
    identity: (u64, u64),
    manifest_present: bool,
    package: Arc<PrivatePackage>,
}

impl PrivateSourceRoot {
    #[cfg(test)]
    pub fn open(
        root_path: &Path,
        root_url: &str,
        admission: SourceAdmission,
    ) -> Result<Self, String> {
        Self::open_with_budget(
            root_path,
            root_url,
            admission,
            Arc::new(Mutex::new(PrivateResourceBudget::default())),
        )
    }

    pub(crate) fn open_with_budget(
        root_path: &Path,
        root_url: &str,
        admission: SourceAdmission,
        budget: Arc<Mutex<PrivateResourceBudget>>,
    ) -> Result<Self, String> {
        valid_private_root_url(root_url)?;
        let root = PrivatePackage::open_selected_root(root_path)?;
        Ok(Self {
            root,
            root_path: root_path.into(),
            root_url: root_url.into(),
            admission,
            packages: Vec::new(),
            requested: HashMap::new(),
            canonical: HashMap::new(),
            weak_canonical: HashSet::new(),
            total_bytes: 0,
            expected: None,
            aliases: HashMap::new(),
            budget,
            seeded_hashes: HashMap::new(),
        })
    }

    pub(crate) fn seed_package(
        &mut self,
        package: Arc<PrivatePackage>,
        hashes: &HashMap<PathBuf, String>,
    ) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        if !self.packages.is_empty() || hashes.is_empty() || hashes.len() > MAX_MODULES {
            return Err("Invalid pinned private package source".into());
        }
        let requested_root = package
            .requested_root()
            .strip_prefix(&self.root_path)
            .map_err(|_| "Pinned package is outside selected source root")?
            .to_path_buf();
        let canonical_root = package
            .root_path()
            .strip_prefix(&self.root_path)
            .map_err(|_| "Pinned package is outside selected source root")?
            .to_path_buf();
        let metadata = package
            .directory()
            .metadata()
            .map_err(|_| "Pinned package root identity unavailable")?;
        let identity = (metadata.dev(), metadata.ino());
        for (relative, expected) in hashes {
            let mut file = package
                .read(relative, &self.admission)?
                .ok_or("Pinned package source is unavailable")?;
            let mut bytes = Vec::new();
            (&mut file)
                .take(MAX_MODULE_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot read pinned package source")?;
            if bytes.len() as u64 > MAX_MODULE_BYTES
                || format!("{:x}", Sha256::digest(&bytes)) != *expected
            {
                return Err("Pinned package source changed before resource planning".into());
            }
            self.seeded_hashes
                .insert(canonical_root.join(relative), expected.clone());
        }
        self.packages.push(PrivateSourcePackage {
            requested_root,
            canonical_root,
            identity,
            manifest_present: true,
            package,
        });
        Ok(())
    }

    /// Runtime restoration has an already identity-checked V1 source-root FD.
    /// Retain that same directory for V2 reads without reopening its pathname.
    pub(crate) fn seed_pinned_directory(
        &mut self,
        package: Arc<PrivatePackage>,
    ) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        if !self.packages.is_empty() {
            return Err("Private source root already has a pinned directory".into());
        }
        let requested_root = package
            .requested_root()
            .strip_prefix(&self.root_path)
            .map_err(|_| "Pinned directory is outside selected source root")?
            .to_path_buf();
        let canonical_root = package
            .root_path()
            .strip_prefix(&self.root_path)
            .map_err(|_| "Pinned directory is outside selected source root")?
            .to_path_buf();
        let metadata = package
            .directory()
            .metadata()
            .map_err(|_| "Pinned directory identity unavailable")?;
        let manifest_present = match open_confined(package.directory(), Path::new("package.json")) {
            Ok(file) => {
                if !file
                    .metadata()
                    .map_err(|_| "Pinned manifest identity unavailable")?
                    .is_file()
                {
                    return Err("Pinned package manifest is not a regular file".into());
                }
                true
            }
            Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => {
                false
            }
            Err(_) => return Err("Pinned package manifest is unavailable".into()),
        };
        self.packages.push(PrivateSourcePackage {
            requested_root,
            canonical_root,
            identity: (metadata.dev(), metadata.ino()),
            manifest_present,
            package,
        });
        Ok(())
    }

    fn remember_nested_package(
        &mut self,
        requested_root: PathBuf,
        canonical_root: PathBuf,
        directory: &File,
    ) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        let metadata = directory
            .metadata()
            .map_err(|_| "Nested package identity unavailable")?;
        if !metadata.is_dir() || self.packages.len() >= MAX_MODULES * 2 {
            return Err("Nested package source limit exceeded".into());
        }
        let identity = (metadata.dev(), metadata.ino());
        for previous in &self.packages {
            if (previous.requested_root == requested_root
                || previous.canonical_root == canonical_root)
                && (previous.canonical_root != canonical_root || previous.identity != identity)
            {
                return Err("Nested package root changed during source planning".into());
            }
        }
        let package = if let Some(previous) = self.packages.iter().find(|previous| {
            previous.canonical_root == canonical_root && previous.identity == identity
        }) {
            Arc::clone(&previous.package)
        } else {
            let mut budget = self
                .budget
                .lock()
                .map_err(|_| "Private source budget unavailable")?;
            if budget.package_leases + budget.external_package_leases >= 128 {
                return Err("Nested package source aggregate limit exceeded".into());
            }
            budget.package_leases += 1;
            Arc::new(PrivatePackage::from_pinned_directory(
                directory
                    .try_clone()
                    .map_err(|_| "Nested package directory unavailable")?,
                self.root_path.join(&requested_root),
                self.root_path.join(&canonical_root),
            )?)
        };
        self.packages.push(PrivateSourcePackage {
            requested_root,
            canonical_root,
            identity,
            manifest_present: true,
            package,
        });
        Ok(())
    }

    pub fn restrict_to_snapshot(
        &mut self,
        reads: &[PrivateResourceRead],
        aliases: &[ModuleAlias],
    ) -> Result<(), String> {
        if self.expected.is_some()
            || !self.requested.is_empty()
            || reads.is_empty()
            || reads.len() > MAX_MODULES
            || aliases.len() > MAX_MODULES
            || aliases
                .iter()
                .map(|alias| alias.url.len() + alias.canonical_url.len())
                .sum::<usize>()
                > 256 * 1024
        {
            return Err("Invalid private source snapshot".into());
        }
        let mut expected = HashMap::new();
        let mut total = 0usize;
        for read in reads {
            private_resource_relative(&self.root_url, &read.url)?;
            if read.byte_length > MAX_MODULE_BYTES as usize
                || read.sha256.len() != 64
                || !read
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                || expected
                    .insert(read.url.clone(), (read.byte_length, read.sha256.clone()))
                    .is_some()
            {
                return Err("Invalid private source snapshot read".into());
            }
            total = total.saturating_add(read.byte_length);
            if total > MAX_GRAPH_BYTES {
                return Err("Private source snapshot byte limit exceeded".into());
            }
        }
        let mut selected_aliases = HashMap::new();
        for alias in aliases {
            let requested = private_resource_relative(&self.root_url, &alias.url)?;
            let canonical = private_resource_relative(&self.root_url, &alias.canonical_url)?;
            if alias.url == alias.canonical_url
                || expected.contains_key(&alias.url)
                || !expected.contains_key(&alias.canonical_url)
                || selected_aliases
                    .insert(alias.url.clone(), alias.canonical_url.clone())
                    .is_some()
            {
                return Err("Invalid private source snapshot alias".into());
            }
            self.admission
                .reserve_private_path(&self.root_path.join(requested))?;
            self.admission
                .reserve_namespace(&self.root_path.join(canonical))?;
        }
        self.expected = Some(expected);
        self.aliases = selected_aliases;
        Ok(())
    }

    pub fn identity(&self) -> Result<(u64, u64), String> {
        use std::os::unix::fs::MetadataExt;
        let metadata = self
            .root
            .metadata()
            .map_err(|_| "Private source root unavailable")?;
        Ok((metadata.dev(), metadata.ino()))
    }

    fn admit_found(
        &self,
        purpose: SourceReadPurpose,
        requested: &Path,
        resolved: &Path,
        parent: Option<&File>,
        name: Option<&std::ffi::OsStr>,
        file: Option<&File>,
    ) -> Result<(), String> {
        if purpose == SourceReadPurpose::Module {
            self.admission
                .host_package_name(requested, resolved, parent, name, file)?;
        }
        Ok(())
    }

    fn admit_missing(
        &self,
        purpose: SourceReadPurpose,
        requested: &Path,
        resolved: &Path,
        parent: Option<&File>,
        name: Option<&std::ffi::OsStr>,
    ) -> Result<(), String> {
        if purpose == SourceReadPurpose::Module {
            self.admission
                .host_package_name(requested, resolved, parent, name, None)
        } else {
            self.admission
                .reserve_missing_package_metadata(requested, resolved, parent, name)
        }
    }

    pub fn read_resource(&mut self, input: &str) -> Result<Option<Arc<SourceResource>>, String> {
        self.read_resource_with_purpose(input, SourceReadPurpose::Module)
    }

    pub fn read_resource_with_purpose(
        &mut self,
        input: &str,
        purpose: SourceReadPurpose,
    ) -> Result<Option<Arc<SourceResource>>, String> {
        use std::os::unix::fs::MetadataExt;
        let requested_relative = private_resource_relative(&self.root_url, input)?;
        if purpose == SourceReadPurpose::PackageMetadata
            && requested_relative.file_name() != Some(std::ffi::OsStr::new("package.json"))
        {
            return Err("Package metadata purpose requires exact package.json".into());
        }
        let requested_path = self.root_path.join(&requested_relative);
        if purpose == SourceReadPurpose::Module {
            self.admission.reserve_namespace(&requested_path)?;
        }
        if let Some(snapshot) = self.requested.get(input) {
            if self.expected.as_ref().is_some_and(|expected| {
                !expected.contains_key(input) && !self.aliases.contains_key(input)
            }) {
                return Err("Private source is outside its admitted snapshot".into());
            }
            if purpose == SourceReadPurpose::PackageMetadata
                || !self.weak_canonical.contains(&snapshot.canonical_url)
            {
                return Ok(Some(snapshot.clone()));
            }
        }
        let target = self
            .aliases
            .get(input)
            .cloned()
            .unwrap_or_else(|| input.to_owned());
        let relative = private_resource_relative(&self.root_url, &target)?;
        if purpose == SourceReadPurpose::PackageMetadata
            && relative.file_name() != Some(std::ffi::OsStr::new("package.json"))
        {
            return Err("Package metadata purpose requires exact package.json".into());
        }
        if target != input {
            self.admit_found(
                purpose,
                &requested_path,
                &self.root_path.join(&relative),
                None,
                None,
                None,
            )?;
        }
        let nested_pin = self
            .packages
            .iter()
            .filter_map(|package| {
                let prefix = if relative.starts_with(&package.requested_root) {
                    &package.requested_root
                } else if relative.starts_with(&package.canonical_root) {
                    &package.canonical_root
                } else {
                    return None;
                };
                let inner = relative.strip_prefix(prefix).ok()?;
                Some((
                    prefix.components().count(),
                    package.canonical_root.clone(),
                    Arc::clone(&package.package),
                    inner.to_path_buf(),
                ))
            })
            .max_by_key(|(depth, _, _, _)| *depth)
            .filter(|(_, _, _, inner)| {
                inner.components().any(|component| {
                    matches!(component, Component::Normal(name) if name == "node_modules")
                })
            })
            .map(|(_, root, package, inner)| (root, package, inner));
        let (file, canonical_relative, parent, name) = if let Some((pinned_root, package, inner)) =
            nested_pin
        {
            let pinned_request = pinned_root.join(inner);
            match open_package_source_with_pin(
                &self.root,
                &self.root_path,
                &pinned_request,
                PackageWalkRole::Host,
                Some((&pinned_root, package.directory())),
            )? {
                PackageWalk::Found(file, resolved, parent, name) => {
                    self.admit_found(
                        purpose,
                        &requested_path,
                        &self.root_path.join(&resolved),
                        Some(&parent),
                        Some(&name),
                        Some(&file),
                    )?;
                    if name == "package.json" {
                        self.remember_nested_package(
                            relative
                                .parent()
                                .ok_or("Nested package path is invalid")?
                                .to_path_buf(),
                            resolved
                                .parent()
                                .ok_or("Nested package path is invalid")?
                                .to_path_buf(),
                            &parent,
                        )?;
                    }
                    (file, resolved, parent, name)
                }
                PackageWalk::Missing(resolved, parent, name) => {
                    self.admit_missing(
                        purpose,
                        &requested_path,
                        &self.root_path.join(&resolved),
                        parent.as_ref(),
                        name.as_deref(),
                    )?;
                    return Ok(None);
                }
                PackageWalk::OutsideAllowlist => {
                    unreachable!("Host package walk has no Guest allowlist")
                }
            }
        } else if relative.file_name() == Some(std::ffi::OsStr::new("package.json")) {
            if let Some(pinned) = self.packages.iter().find(|package| {
                relative == package.requested_root.join("package.json")
                    || relative == package.canonical_root.join("package.json")
            }) {
                let inner = Path::new("package.json");
                let Some(file) =
                    pinned
                        .package
                        .read_with_purpose(inner, &self.admission, purpose)?
                else {
                    if pinned.manifest_present {
                        return Err("Pinned package manifest disappeared".into());
                    }
                    return Ok(None);
                };
                let canonical_relative = pinned.canonical_root.join(inner);
                let parent = pinned
                    .package
                    .directory()
                    .try_clone()
                    .map_err(|_| "Pinned package root unavailable")?;
                let name = std::ffi::OsString::from("package.json");
                self.admit_found(
                    purpose,
                    &requested_path,
                    &self.root_path.join(&canonical_relative),
                    Some(&parent),
                    Some(&name),
                    Some(&file),
                )?;
                (file, canonical_relative, parent, name)
            } else {
                match PrivatePackage::open_in_with_purpose(
                    &self.root,
                    &self.root_path,
                    &self.root_path.join(&relative),
                    &self.admission,
                    purpose,
                )? {
                    Some((package, file)) => {
                        let canonical_root = package
                            .root_path()
                            .strip_prefix(&self.root_path)
                            .map_err(|_| "Private package escapes its source root")?
                            .to_path_buf();
                        let requested_root = relative
                            .parent()
                            .ok_or("Invalid private package path")?
                            .to_path_buf();
                        let metadata = package
                            .directory()
                            .metadata()
                            .map_err(|_| "Private package identity unavailable")?;
                        let identity = (metadata.dev(), metadata.ino());
                        for previous in &self.packages {
                            if (previous.requested_root == requested_root
                                || previous.canonical_root == canonical_root)
                                && (previous.canonical_root != canonical_root
                                    || previous.identity != identity)
                            {
                                return Err(
                                    "Private package root changed during source planning".into()
                                );
                            }
                        }
                        if self.packages.len() >= MAX_MODULES * 2 {
                            return Err("Private package alias limit exceeded".into());
                        }
                        let package = if let Some(previous) =
                            self.packages.iter().find(|previous| {
                                previous.canonical_root == canonical_root
                                    && previous.identity == identity
                            }) {
                            Arc::clone(&previous.package)
                        } else {
                            let mut budget = self
                                .budget
                                .lock()
                                .map_err(|_| "Private source budget unavailable")?;
                            if budget.package_leases + budget.external_package_leases >= 128 {
                                return Err(
                                    "Private package source aggregate limit exceeded".into()
                                );
                            }
                            budget.package_leases += 1;
                            Arc::new(package)
                        };
                        let parent = package
                            .directory()
                            .try_clone()
                            .map_err(|_| "Private package root unavailable")?;
                        let name = std::ffi::OsString::from("package.json");
                        self.packages.push(PrivateSourcePackage {
                            requested_root,
                            canonical_root: canonical_root.clone(),
                            identity,
                            manifest_present: true,
                            package,
                        });
                        (file, canonical_root.join("package.json"), parent, name)
                    }
                    None => {
                        if target != input {
                            return Err("Private source snapshot alias is missing".into());
                        }
                        return Ok(None);
                    }
                }
            }
        } else {
            let pinned = self
                    .packages
                    .iter()
                    .filter_map(|package| {
                        let prefix = if relative.starts_with(&package.requested_root) {
                            &package.requested_root
                        } else if relative.starts_with(&package.canonical_root) {
                            &package.canonical_root
                        } else {
                            return None;
                        };
                        let inner = relative.strip_prefix(prefix).ok()?;
                        if inner.as_os_str().is_empty()
                            || inner.components().any(|component| {
                                matches!(component, Component::Normal(name) if name == "node_modules")
                            })
                        {
                            return None;
                        }
                        Some((package, inner.to_path_buf()))
                    })
                    .max_by_key(|(package, _)| package.canonical_root.components().count());
            if let Some((package, inner)) = pinned {
                let Some(file) =
                    package
                        .package
                        .read_with_purpose(&inner, &self.admission, purpose)?
                else {
                    self.admit_missing(
                        purpose,
                        &requested_path,
                        &self.root_path.join(&package.canonical_root).join(&inner),
                        None,
                        None,
                    )?;
                    if target != input {
                        return Err("Private source snapshot alias is missing".into());
                    }
                    return Ok(None);
                };
                let canonical_relative = package.canonical_root.join(&inner);
                self.admit_found(
                    purpose,
                    &requested_path,
                    &self.root_path.join(&canonical_relative),
                    None,
                    None,
                    Some(&file),
                )?;
                let parent = if let Some(parent_path) = inner.parent()
                    && !parent_path.as_os_str().is_empty()
                {
                    open_confined(package.package.directory(), parent_path)
                        .map_err(|_| "Private package parent unavailable")?
                } else {
                    package
                        .package
                        .directory()
                        .try_clone()
                        .map_err(|_| "Private package root unavailable")?
                };
                let name = inner
                    .file_name()
                    .ok_or("Invalid private module path")?
                    .to_os_string();
                (file, canonical_relative, parent, name)
            } else {
                match open_package_source(
                    &self.root,
                    &self.root_path,
                    &relative,
                    PackageWalkRole::Host,
                )? {
                    PackageWalk::Found(file, resolved, parent, name) => {
                        self.admit_found(
                            purpose,
                            &requested_path,
                            &self.root_path.join(&resolved),
                            Some(&parent),
                            Some(&name),
                            Some(&file),
                        )?;
                        (file, resolved, parent, name)
                    }
                    PackageWalk::Missing(resolved, parent, name) => {
                        self.admit_missing(
                            purpose,
                            &requested_path,
                            &self.root_path.join(&resolved),
                            parent.as_ref(),
                            name.as_deref(),
                        )?;
                        if target != input {
                            return Err("Private source snapshot alias is missing".into());
                        }
                        return Ok(None);
                    }
                    PackageWalk::OutsideAllowlist => {
                        unreachable!("Host package walk has no Guest allowlist")
                    }
                }
            }
        };
        let canonical_url = private_resource_url(&self.root_url, &canonical_relative)?;
        if target != input && canonical_url != target {
            return Err("Private source snapshot alias changed".into());
        }
        if let Some(expected) = &self.expected
            && (!expected.contains_key(&canonical_url)
                || (input != canonical_url
                    && self.aliases.get(input).map(String::as_str) != Some(canonical_url.as_str())))
        {
            return Err("Private source is outside its admitted snapshot".into());
        }
        let metadata = file
            .metadata()
            .map_err(|_| "Private source identity unavailable")?;
        if !metadata.is_file() || metadata.len() > MAX_MODULE_BYTES {
            return Err("Private source is not a bounded regular file".into());
        }
        let identity = (metadata.dev(), metadata.ino());
        if let Some((snapshot, previous)) = self.canonical.get(&canonical_url) {
            if *previous != identity {
                return Err("Private source changed under one canonical identity".into());
            }
            if !self.weak_canonical.contains(&canonical_url) {
                self.requested.insert(input.into(), snapshot.clone());
                return Ok(Some(snapshot.clone()));
            }
        }
        let mut bytes = Vec::new();
        (&file)
            .take(MAX_MODULE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read private source")?;
        if bytes.len() as u64 > MAX_MODULE_BYTES
            || (self.canonical.len() >= MAX_MODULES && !self.canonical.contains_key(&canonical_url))
            || (self.requested.len() >= MAX_MODULES * 2 && !self.requested.contains_key(input))
            || (!self.canonical.contains_key(&canonical_url)
                && self.total_bytes.saturating_add(bytes.len()) > MAX_GRAPH_BYTES)
        {
            return Err("Private source graph limit exceeded".into());
        }
        std::str::from_utf8(&bytes).map_err(|_| "Private source must be valid UTF-8")?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        if self
            .seeded_hashes
            .get(&canonical_relative)
            .is_some_and(|expected| expected != &sha256)
        {
            return Err("Pinned package source changed during resource planning".into());
        }
        if let Some(expected) = &self.expected
            && expected.get(&canonical_url) != Some(&(bytes.len(), sha256.clone()))
        {
            return Err("Private source snapshot integrity changed".into());
        }
        if let Some((snapshot, previous)) = self.canonical.get(&canonical_url)
            && (*previous != identity || snapshot.sha256 != sha256 || snapshot.bytes != bytes)
        {
            return Err("Private source changed under one canonical identity".into());
        }
        let weak = if purpose == SourceReadPurpose::PackageMetadata {
            let weak = self.admission.host_package_metadata(
                &requested_path,
                &self.root_path.join(&canonical_relative),
                &parent,
                &name,
                &file,
                &sha256,
            )?;
            if target != input {
                self.admission.host_package_metadata(
                    &self.root_path.join(&relative),
                    &self.root_path.join(&canonical_relative),
                    &parent,
                    &name,
                    &file,
                    &sha256,
                )?;
            }
            weak
        } else {
            self.admission.host_package_name(
                &requested_path,
                &self.root_path.join(&canonical_relative),
                Some(&parent),
                Some(&name),
                Some(&file),
            )?;
            false
        };
        if let Some((snapshot, _)) = self.canonical.get(&canonical_url) {
            let snapshot = snapshot.clone();
            if !weak {
                self.weak_canonical.remove(&canonical_url);
            }
            self.requested.insert(input.into(), snapshot.clone());
            return Ok(Some(snapshot));
        }
        if !self.seeded_hashes.contains_key(&canonical_relative) {
            let mut budget = self
                .budget
                .lock()
                .map_err(|_| "Private source budget unavailable")?;
            let (device, inode) = self.identity()?;
            let key = format!("{device}:{inode}:{}:{canonical_url}", self.root_url);
            if let Some(previous) = budget.canonical.get(&key) {
                if *previous != (bytes.len(), sha256.clone()) {
                    return Err("Private source changed under one budget identity".into());
                }
            } else {
                if budget.canonical.len() + budget.external_read_count >= MAX_MODULES
                    || budget
                        .total_bytes
                        .saturating_add(budget.external_bytes)
                        .saturating_add(bytes.len())
                        > MAX_GRAPH_BYTES
                {
                    return Err("Private source aggregate limit exceeded".into());
                }
                budget.canonical.insert(key, (bytes.len(), sha256.clone()));
                budget.total_bytes += bytes.len();
            }
        }
        let resource = Arc::new(SourceResource {
            sha256,
            bytes,
            canonical_url: canonical_url.clone(),
            metadata_only: false,
        });
        self.total_bytes += resource.bytes.len();
        if weak {
            self.weak_canonical.insert(canonical_url.clone());
        }
        self.canonical
            .insert(canonical_url, (resource.clone(), identity));
        self.requested.insert(input.into(), resource.clone());
        Ok(Some(resource))
    }
}

fn valid_private_root_url(root_url: &str) -> Result<(), String> {
    let id = root_url
        .strip_prefix("holo-plugins:///")
        .and_then(|tail| tail.strip_suffix('/'))
        .ok_or("Invalid private source root URL")?;
    let url = Url::parse(root_url).map_err(|_| "Invalid private source root URL")?;
    if id.is_empty()
        || id.contains('/')
        || id.len() > 128
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        || url.as_str() != root_url
        || url.host_str().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid private source root URL".into());
    }
    Ok(())
}

pub(crate) fn private_resource_relative(root_url: &str, input: &str) -> Result<PathBuf, String> {
    let suffix = input
        .strip_prefix(root_url)
        .filter(|value| !value.is_empty())
        .ok_or("Private source URL is outside its root")?;
    let lowercase = suffix.to_ascii_lowercase();
    if suffix.contains('\\')
        || suffix.contains('\0')
        || lowercase.contains("%2f")
        || lowercase.contains("%5c")
        || lowercase.contains("%00")
    {
        return Err("Invalid private source path encoding".into());
    }
    let url = Url::parse(input).map_err(|_| "Invalid private source URL")?;
    if input.len() > 4096
        || url.as_str() != input
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_some()
    {
        return Err("Invalid private source URL".into());
    }
    let mut file_url = Url::parse("file:///").unwrap();
    file_url.set_path(&format!("/{suffix}"));
    let path = file_url
        .to_file_path()
        .map_err(|_| "Invalid private source path")?;
    let relative = path
        .strip_prefix(Path::new("/"))
        .map_err(|_| "Invalid private source path")?;
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
        || private_resource_url(root_url, relative)? != input
    {
        return Err("Private source URL is not canonically encoded".into());
    }
    Ok(relative.into())
}

pub(crate) fn private_resource_url(root_url: &str, relative: &Path) -> Result<String, String> {
    let mut url = Url::parse(root_url).map_err(|_| "Invalid private source root URL")?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Invalid private source root URL")?;
        segments.pop_if_empty();
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err("Invalid private source path".into());
            };
            segments.push(
                name.to_str()
                    .ok_or("Invalid private source path encoding")?,
            );
        }
    }
    Ok(url.into())
}

/// A trusted Host package is opened once through the same bounded directory
/// link walker as Guest resources. Later reads use its retained physical root
/// descriptor, never a new lookup of the package alias.
#[derive(Debug)]
pub(crate) struct PrivatePackage {
    directory: File,
    requested_root: PathBuf,
    resolved_root: PathBuf,
}

impl PrivatePackage {
    pub(crate) fn from_pinned_directory(
        directory: File,
        requested_root: PathBuf,
        resolved_root: PathBuf,
    ) -> Result<Self, String> {
        if !strict_package_absolute(&requested_root)
            || !strict_package_absolute(&resolved_root)
            || !directory
                .metadata()
                .map_err(|_| "Pinned package root unavailable")?
                .is_dir()
        {
            return Err("Invalid pinned package directory".into());
        }
        Ok(Self {
            directory,
            requested_root,
            resolved_root,
        })
    }

    pub(crate) fn open(
        root_path: &Path,
        manifest_path: &Path,
        admission: &SourceAdmission,
    ) -> Result<Option<(Self, File)>, String> {
        let root = Self::open_selected_root(root_path)?;
        Self::open_in(&root, root_path, manifest_path, admission)
    }

    pub(crate) fn open_selected_root(root_path: &Path) -> Result<File, String> {
        if !strict_package_absolute(root_path) {
            return Err("Invalid private package root".into());
        }
        let anchor = File::open("/").map_err(|_| "Source root unavailable")?;
        let root = if root_path == Path::new("/") {
            anchor
        } else {
            open_confined(
                &anchor,
                root_path
                    .strip_prefix("/")
                    .map_err(|_| "Invalid private package root")?,
            )
            .map_err(|_| "Private package root is unavailable or not confined")?
        };
        if !root
            .metadata()
            .map_err(|_| "Private package root is unavailable")?
            .is_dir()
        {
            return Err("Private package root must be a directory".into());
        }
        Ok(root)
    }

    pub(crate) fn open_in(
        root: &File,
        root_path: &Path,
        manifest_path: &Path,
        admission: &SourceAdmission,
    ) -> Result<Option<(Self, File)>, String> {
        Self::open_in_with_purpose(
            root,
            root_path,
            manifest_path,
            admission,
            SourceReadPurpose::Module,
        )
    }

    pub(crate) fn open_in_with_purpose(
        root: &File,
        root_path: &Path,
        manifest_path: &Path,
        admission: &SourceAdmission,
        purpose: SourceReadPurpose,
    ) -> Result<Option<(Self, File)>, String> {
        if !strict_package_absolute(root_path)
            || !strict_package_absolute(manifest_path)
            || manifest_path.file_name() != Some(std::ffi::OsStr::new("package.json"))
        {
            return Err("Invalid private package path".into());
        }
        let relative = manifest_path
            .strip_prefix(root_path)
            .map_err(|_| "Private package is outside selected root")?;
        if relative.as_os_str().is_empty() {
            return Err("Invalid private package path".into());
        }
        if !root
            .metadata()
            .map_err(|_| "Private package root is unavailable")?
            .is_dir()
        {
            return Err("Private package root must be a directory".into());
        }
        match open_package_source(root, root_path, relative, PackageWalkRole::Host)? {
            PackageWalk::Found(file, resolved, parent, name) => {
                let resolved_path = root_path.join(&resolved);
                if resolved_path.as_os_str().as_bytes().len() > 4096
                    || resolved_path.to_str().is_none()
                {
                    return Err("Invalid private package path".into());
                }
                if purpose == SourceReadPurpose::Module {
                    admission.host_package_name(
                        manifest_path,
                        &resolved_path,
                        Some(&parent),
                        Some(&name),
                        Some(&file),
                    )?;
                }
                let metadata = file.metadata().map_err(|_| "Private package unavailable")?;
                if !metadata.is_file() {
                    return Err("Private package manifest must be a regular file".into());
                }
                Ok(Some((
                    Self {
                        directory: parent,
                        requested_root: manifest_path
                            .parent()
                            .ok_or("Invalid private package path")?
                            .into(),
                        resolved_root: resolved_path
                            .parent()
                            .ok_or("Invalid private package path")?
                            .into(),
                    },
                    file,
                )))
            }
            PackageWalk::Missing(resolved, parent, name) => {
                if purpose == SourceReadPurpose::Module {
                    admission.host_package_name(
                        manifest_path,
                        &root_path.join(&resolved),
                        parent.as_ref(),
                        name.as_deref(),
                        None,
                    )?;
                } else {
                    admission.reserve_missing_package_metadata(
                        manifest_path,
                        &root_path.join(&resolved),
                        parent.as_ref(),
                        name.as_deref(),
                    )?;
                }
                Ok(None)
            }
            PackageWalk::OutsideAllowlist => unreachable!("Host package has no Guest allowlist"),
        }
    }

    pub(crate) fn root_path(&self) -> &Path {
        &self.resolved_root
    }

    pub(crate) fn requested_root(&self) -> &Path {
        &self.requested_root
    }

    pub(crate) fn directory(&self) -> &File {
        &self.directory
    }

    pub(crate) fn read(
        &self,
        relative: &Path,
        admission: &SourceAdmission,
    ) -> Result<Option<File>, String> {
        self.read_with_purpose(relative, admission, SourceReadPurpose::Module)
    }

    pub(crate) fn read_with_purpose(
        &self,
        relative: &Path,
        admission: &SourceAdmission,
        purpose: SourceReadPurpose,
    ) -> Result<Option<File>, String> {
        let components = relative.components().collect::<Vec<_>>();
        if components.is_empty()
            || components
                .iter()
                .any(|component| !matches!(component, Component::Normal(_)))
            || relative
                .components()
                .collect::<PathBuf>()
                .as_os_str()
                .as_bytes()
                != relative.as_os_str().as_bytes()
        {
            return Err("Invalid private package relative path".into());
        }
        if purpose == SourceReadPurpose::PackageMetadata
            && relative.file_name() != Some(std::ffi::OsStr::new("package.json"))
        {
            return Err("Package metadata purpose requires exact package.json".into());
        }
        let requested = self.requested_root.join(relative);
        let resolved = self.resolved_root.join(relative);
        if requested.as_os_str().as_bytes().len() > 4096
            || resolved.as_os_str().as_bytes().len() > 4096
        {
            return Err("Invalid private package relative path".into());
        }
        let parent_relative = relative.parent().ok_or("Invalid private package path")?;
        let parent = if parent_relative.as_os_str().is_empty() {
            self.directory
                .try_clone()
                .map_err(|_| "Private package root unavailable")?
        } else {
            match open_confined(&self.directory, parent_relative) {
                Ok(parent) => parent,
                Err(error)
                    if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) =>
                {
                    if purpose == SourceReadPurpose::Module {
                        admission.host_package_name(&requested, &resolved, None, None, None)?;
                    } else {
                        admission
                            .reserve_missing_package_metadata(&requested, &resolved, None, None)?;
                    }
                    return Ok(None);
                }
                Err(_) => return Err("Private package path is unavailable or not confined".into()),
            }
        };
        let name = relative.file_name().ok_or("Invalid private package path")?;
        let file = match openat_source(&parent, name, false) {
            Ok(file) => file,
            Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => {
                if purpose == SourceReadPurpose::Module {
                    admission.host_package_name(
                        &requested,
                        &resolved,
                        Some(&parent),
                        Some(name),
                        None,
                    )?;
                } else {
                    admission.reserve_missing_package_metadata(
                        &requested,
                        &resolved,
                        Some(&parent),
                        Some(name),
                    )?;
                }
                return Ok(None);
            }
            Err(_) => return Err("Private package path is unavailable or not confined".into()),
        };
        if purpose == SourceReadPurpose::Module {
            admission.host_package_name(
                &requested,
                &resolved,
                Some(&parent),
                Some(name),
                Some(&file),
            )?;
        }
        if !file
            .metadata()
            .map_err(|_| "Private package file unavailable")?
            .is_file()
        {
            return Err("Private package file must be a regular file".into());
        }
        Ok(Some(file))
    }
}

fn strict_package_absolute(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir => normalized.push("/"),
            Component::Normal(part) => normalized.push(part),
            _ => return false,
        }
    }
    normalized.as_os_str().as_bytes() == path.as_os_str().as_bytes()
}

enum PackageWalkRole<'a> {
    Guest {
        query: Option<&'a str>,
        fragment: Option<&'a str>,
        admission: &'a SourceAdmission,
        allowed: Option<&'a HashSet<String>>,
        purpose: SourceReadPurpose,
    },
    Host,
}

enum PackageWalk {
    Found(File, PathBuf, File, OsString),
    Missing(PathBuf, Option<File>, Option<OsString>),
    OutsideAllowlist,
}

fn open_package_source(
    root: &File,
    root_path: &Path,
    relative: &Path,
    role: PackageWalkRole<'_>,
) -> Result<PackageWalk, String> {
    open_package_source_with_pin(root, root_path, relative, role, None)
}

fn open_package_source_with_pin(
    root: &File,
    root_path: &Path,
    relative: &Path,
    role: PackageWalkRole<'_>,
    pinned: Option<(&Path, &File)>,
) -> Result<PackageWalk, String> {
    if pinned.is_some() && !matches!(&role, PackageWalkRole::Host) {
        return Err("Pinned package walk is Host-only".into());
    }
    let mut pending = relative
        .components()
        .map(|component| match component {
            Component::Normal(name) => Ok(name.to_os_string()),
            _ => Err("Invalid module path".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if pending.is_empty() {
        return Err("Invalid module path".into());
    }
    let pinned = pinned
        .map(|(prefix, directory)| {
            let prefix = prefix
                .components()
                .map(|component| match component {
                    Component::Normal(name) => Ok(name.to_os_string()),
                    _ => Err("Invalid pinned package prefix".to_string()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, String>((prefix, directory))
        })
        .transpose()?;
    let mut links = 0;
    'resolve: loop {
        let (mut directory, mut resolved, start) = if let Some((prefix, pinned_directory)) = &pinned
            && pending.starts_with(prefix)
        {
            (
                pinned_directory
                    .try_clone()
                    .map_err(|_| "Pinned package directory unavailable")?,
                prefix.clone(),
                prefix.len(),
            )
        } else {
            (
                root.try_clone().map_err(|_| "Cannot open workspace")?,
                Vec::<OsString>::new(),
                0,
            )
        };
        if start >= pending.len() {
            return Err("Pinned package resource path is invalid".into());
        }
        for index in start..pending.len() {
            let name = &pending[index];
            let mut candidate = resolved.clone();
            candidate.push(name.clone());
            let candidate_path = components_path(&candidate);
            if let PackageWalkRole::Guest {
                admission, purpose, ..
            } = &role
            {
                admission.check_namespace(&root_path.join(&candidate_path))?;
                admission.check_slot(&directory, name)?;
                admission.check_metadata_namespace(&root_path.join(&candidate_path), *purpose)?;
                admission.check_metadata_slot(&directory, name, *purpose)?;
            }
            if index + 1 == pending.len() {
                if let PackageWalkRole::Guest {
                    query,
                    fragment,
                    allowed,
                    ..
                } = &role
                {
                    let canonical_url = module_url(&candidate_path, *query, *fragment)?;
                    if !valid_module_url(&canonical_url) {
                        return Err("Module path is unavailable or not confined".into());
                    }
                    if allowed.is_some_and(|urls| !urls.contains(&canonical_url)) {
                        return Ok(PackageWalk::OutsideAllowlist);
                    }
                }
                let file = match openat_source(&directory, name, false) {
                    Ok(file) => file,
                    Err(error)
                        if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) =>
                    {
                        return Ok(PackageWalk::Missing(
                            candidate_path,
                            Some(directory),
                            Some(name.clone()),
                        ));
                    }
                    Err(_) => return Err("Module path is unavailable or not confined".into()),
                };
                return Ok(PackageWalk::Found(
                    file,
                    candidate_path,
                    directory,
                    name.clone(),
                ));
            }
            match openat_source(&directory, name, true) {
                Ok(next) => {
                    directory = next;
                    resolved.push(name.clone());
                }
                Err(error) => {
                    let target = match read_package_link(&directory, name) {
                        Ok(target) => target,
                        Err(_)
                            if matches!(
                                error.raw_os_error(),
                                Some(libc::ENOENT | libc::ENOTDIR)
                            ) =>
                        {
                            let mut missing = candidate;
                            missing.extend_from_slice(&pending[index + 1..]);
                            return Ok(PackageWalk::Missing(components_path(&missing), None, None));
                        }
                        Err(_) => return Err("Module path is unavailable or not confined".into()),
                    };
                    if !package_link_slot(&resolved, name) || links >= 16 {
                        return Err("Module path is unavailable or not confined".into());
                    }
                    links += 1;
                    let mut next = resolved;
                    for component in Path::new(&target).components() {
                        match component {
                            Component::CurDir => {}
                            Component::Normal(part) => next.push(part.to_os_string()),
                            Component::ParentDir if !next.is_empty() => {
                                next.pop();
                            }
                            _ => return Err("Module path is unavailable or not confined".into()),
                        }
                    }
                    next.extend_from_slice(&pending[index + 1..]);
                    if next.is_empty() || next.len() > 256 {
                        return Err("Module path is unavailable or not confined".into());
                    }
                    pending = next;
                    continue 'resolve;
                }
            }
        }
    }
}

fn components_path(parts: &[OsString]) -> PathBuf {
    parts.iter().collect()
}

fn package_link_slot(parent: &[OsString], name: &std::ffi::OsStr) -> bool {
    let Some(last) = parent.last() else {
        return false;
    };
    if last == "node_modules" {
        return !name.as_bytes().starts_with(b".") && !name.as_bytes().starts_with(b"@");
    }
    last.as_bytes().starts_with(b"@")
        && parent.len() >= 2
        && parent[parent.len() - 2] == "node_modules"
        && !name.as_bytes().starts_with(b".")
}

fn openat_source(directory: &File, name: &std::ffi::OsStr, is_dir: bool) -> std::io::Result<File> {
    let name = CString::new(name.as_bytes()).map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if is_dir { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn read_package_link(directory: &File, name: &std::ffi::OsStr) -> std::io::Result<OsString> {
    let name = CString::new(name.as_bytes()).map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let mut target = [0_u8; 4097];
    let count = unsafe {
        libc::readlinkat(
            directory.as_raw_fd(),
            name.as_ptr(),
            target.as_mut_ptr().cast(),
            target.len(),
        )
    };
    if count <= 0 || count as usize >= target.len() {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    Ok(std::ffi::OsStr::from_bytes(&target[..count as usize]).to_os_string())
}

#[cfg(unix)]
pub(crate) fn open_confined(root: &File, relative: &Path) -> std::io::Result<File> {
    open_confined_before_leaf(root, relative, |_, _, _| Ok(()))
}

#[cfg(unix)]
fn open_confined_before_leaf(
    root: &File,
    relative: &Path,
    mut before_step: impl FnMut(&File, &std::ffi::OsStr, bool) -> std::io::Result<()>,
) -> std::io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let parts = relative.components().collect::<Vec<_>>();
    if parts.is_empty() {
        return Err(std::io::ErrorKind::NotFound.into());
    }
    let mut directory = root.try_clone()?;
    for (index, component) in parts.iter().enumerate() {
        let Component::Normal(part) = component else {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        };
        before_step(&directory, part, index + 1 == parts.len())?;
        let name = CString::new(part.as_bytes()).map_err(|_| std::io::ErrorKind::InvalidInput)?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if index + 1 < parts.len() {
                libc::O_DIRECTORY
            } else {
                0
            };
        // Each ancestor is opened relative to a retained directory descriptor;
        // rename/symlink replacement cannot redirect the walk outside this root.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok(directory)
}

fn equivalent_path_prefix(prefix: &Path, path: &Path) -> Result<bool, String> {
    let prefix = prefix.components().collect::<Vec<_>>();
    let path = path.components().collect::<Vec<_>>();
    if prefix.len() > path.len() {
        return Ok(false);
    }
    for (left, right) in prefix.iter().zip(path.iter()) {
        match (left, right) {
            (Component::RootDir, Component::RootDir) => {}
            (Component::Normal(left), Component::Normal(right))
                if equivalent_name(left, right)? => {}
            _ => return Ok(false),
        }
    }
    Ok(true)
}

fn equivalent_path(left: &Path, right: &Path) -> Result<bool, String> {
    let left = left.components().collect::<Vec<_>>();
    let right = right.components().collect::<Vec<_>>();
    if left.len() != right.len() {
        return Ok(false);
    }
    for (left, right) in left.into_iter().zip(right) {
        match (left, right) {
            (Component::RootDir, Component::RootDir) => {}
            (Component::Normal(left), Component::Normal(right))
                if equivalent_name(left, right)? => {}
            _ => return Ok(false),
        }
    }
    Ok(true)
}

// Conservative macOS namespace equivalence: preserve case and canonical
// Unicode aliases even on case-sensitive volumes. No locale-dependent lookup.
#[cfg(target_os = "macos")]
fn equivalent_name(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> Result<bool, String> {
    use std::{ffi::c_void, os::unix::ffi::OsStrExt};
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithBytes(
            allocator: *const c_void,
            bytes: *const u8,
            length: isize,
            encoding: u32,
            external: u8,
        ) -> *const c_void;
        fn CFStringCompare(left: *const c_void, right: *const c_void, options: usize) -> isize;
        fn CFRelease(value: *const c_void);
    }
    if left == right {
        return Ok(true);
    }
    let (left, right) = (left.as_bytes(), right.as_bytes());
    unsafe {
        let a = CFStringCreateWithBytes(
            std::ptr::null(),
            left.as_ptr(),
            left.len() as isize,
            0x08000100,
            0,
        );
        let b = CFStringCreateWithBytes(
            std::ptr::null(),
            right.as_ptr(),
            right.len() as isize,
            0x08000100,
            0,
        );
        let result = if a.is_null() || b.is_null() {
            Err("Unsupported source namespace encoding".into())
        } else {
            Ok(CFStringCompare(a, b, 1 | 16) == 0)
        };
        if !a.is_null() {
            CFRelease(a);
        }
        if !b.is_null() {
            CFRelease(b);
        }
        result
    }
}
#[cfg(not(target_os = "macos"))]
fn equivalent_name(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> Result<bool, String> {
    Ok(left == right)
}

#[cfg(not(unix))]
fn open_confined(_: &File, _: &Path) -> std::io::Result<File> {
    Err(std::io::ErrorKind::Unsupported.into())
}

#[cfg(test)]
mod privacy_namespace_tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "holo-namespace-race-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(path.join("private")).unwrap();
            fs::write(path.join("entry.mjs"), "export default 1;").unwrap();
            fs::write(path.join("private/host.json"), "{\"marker\":\"A\"}").unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn store(&self) -> SourceStore {
            let admission = SourceAdmission::default();
            let path = self.0.join("private/host.json");
            admission
                .capture(&path, &File::open(&path).unwrap())
                .unwrap();
            SourceStore::with_admission(&self.0.join("entry.mjs"), admission).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn explicit_workspace_entry_is_confined_and_unread_until_guest_phase() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        fs::create_dir(fixture.0.join("nested")).unwrap();
        let entry = fixture.0.join("nested/entry.mjs");
        fs::write(&entry, "export default 2;").unwrap();
        let admission = SourceAdmission::default();
        let store =
            SourceStore::with_workspace_entry(&fixture.0, &entry, admission.clone()).unwrap();
        assert_eq!(store.entry_url, "app://workspace/nested/entry.mjs");
        // Constructing the store selects an entry identity but does not promote
        // its bytes into Guest source before private admission finishes.
        admission
            .capture(&entry, &File::open(&entry).unwrap())
            .unwrap();
        assert!(
            SourceStore::with_workspace_entry(
                &fixture.0,
                &outside.0.join("entry.mjs"),
                SourceAdmission::default(),
            )
            .is_err()
        );
        let mut store =
            SourceStore::with_workspace_entry(&fixture.0, &entry, SourceAdmission::default())
                .unwrap();
        store
            .restrict_to_urls(vec![store.entry_url.clone()])
            .unwrap();
        assert!(
            store
                .read("app://workspace/nested/entry.mjs")
                .unwrap()
                .is_some()
        );
        assert_eq!(
            store
                .read("app://workspace/nested/entry.mjs?query=1")
                .unwrap(),
            None
        );
    }
    #[test]
    fn private_namespace_survives_ancestor_rebinding() {
        let f = Fixture::new();
        let mut store = f.store();
        fs::rename(f.0.join("private"), f.0.join("old")).unwrap();
        fs::create_dir(f.0.join("private")).unwrap();
        fs::write(f.0.join("private/host.json"), "{\"marker\":\"B_PRIVATE\"}").unwrap();
        let result = store.read("app://workspace/private/host.json");
        assert!(result.is_err(), "private namespace exposed: {result:?}");
    }
    #[test]
    fn private_namespace_blocks_open_then_double_replace() {
        let f = Fixture::new();
        let mut store = f.store();
        fs::rename(f.0.join("private/host.json"), f.0.join("private/a.json")).unwrap();
        fs::write(f.0.join("private/host.json"), "{\"marker\":\"B_PRIVATE\"}").unwrap();
        let root = f.0.clone();
        store.after_open = Some(Box::new(move || {
            fs::rename(root.join("private/host.json"), root.join("private/b.json")).unwrap();
            fs::write(root.join("private/host.json"), "{\"marker\":\"C_PRIVATE\"}").unwrap();
        }));
        let result = store.read("app://workspace/private/host.json");
        assert!(
            result.is_err(),
            "opened private replacement exposed: {result:?}"
        );
        assert!(
            store.after_open.is_some(),
            "private namespace must reject before open"
        );
    }

    #[test]
    fn namespace_aliases_reject_before_open_without_blocking_siblings() {
        let f = Fixture::new();
        let mut store = f.store();
        fs::rename(f.0.join("private"), f.0.join("old")).unwrap();
        fs::create_dir(f.0.join("private")).unwrap();
        fs::write(f.0.join("private/host.json"), "{\"marker\":\"B_PRIVATE\"}").unwrap();
        fs::write(
            f.0.join("old/host.json"),
            "{\"marker\":\"OLD_SLOT_PRIVATE\"}",
        )
        .unwrap();
        let mut aliases = vec![
            "private/host.json?fresh=1",
            "%70rivate/%68ost.json",
            "private//host.json",
            "old/host.json",
        ];
        #[cfg(target_os = "macos")]
        aliases.extend(["PRIVATE/HOST.JSON", "old/HOST.JSON"]);
        for alias in aliases {
            store.after_open = Some(Box::new(|| panic!("private alias opened")));
            assert!(
                store.read(&format!("app://workspace/{alias}")).is_err(),
                "{alias}"
            );
            assert!(store.after_open.is_some());
        }
        store.after_open = None;
        fs::write(f.0.join("private/public.json"), "{\"public\":true}").unwrap();
        assert!(
            store
                .read("app://workspace/private/public.json")
                .unwrap()
                .is_some()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unicode_canonical_aliases_of_rebound_namespaces_reject_before_open() {
        let f = Fixture::new();
        let original = f.0.join("private/Café.json");
        fs::write(&original, "{}").unwrap();
        let admission = SourceAdmission::default();
        admission
            .capture(&original, &File::open(&original).unwrap())
            .unwrap();
        let mut store = SourceStore::with_admission(&f.0.join("entry.mjs"), admission).unwrap();
        fs::rename(f.0.join("private"), f.0.join("old")).unwrap();
        fs::create_dir(f.0.join("private")).unwrap();
        fs::write(f.0.join("private/Café.json"), "{\"marker\":\"B_PRIVATE\"}").unwrap();
        for alias in [
            "private/Caf%C3%A9.json",
            "private/Cafe%CC%81.json",
            "PRIVATE/CAFE%CC%81.JSON",
        ] {
            store.after_open = Some(Box::new(|| panic!("Unicode private alias opened")));
            assert!(
                store.read(&format!("app://workspace/{alias}")).is_err(),
                "{alias}"
            );
            assert!(store.after_open.is_some());
        }
    }

    #[test]
    fn external_rebound_private_namespace_blocks_its_current_guest_hardlink() {
        let guest = Fixture::new();
        let external = Fixture::new();
        let admission = SourceAdmission::default();
        let path = external.0.join("private/host.json");
        admission
            .capture(&path, &File::open(&path).unwrap())
            .unwrap();
        let mut store = SourceStore::with_admission(&guest.0.join("entry.mjs"), admission).unwrap();
        fs::rename(external.0.join("private"), external.0.join("old")).unwrap();
        fs::create_dir(external.0.join("private")).unwrap();
        fs::write(&path, "{\"marker\":\"CURRENT_B_PRIVATE\"}").unwrap();
        fs::hard_link(&path, guest.0.join("alias.json")).unwrap();
        let result = store.read("app://workspace/alias.json");
        assert!(
            result.is_err(),
            "current external private identity exposed: {result:?}"
        );
        assert!(store.read("app://workspace/entry.mjs").unwrap().is_some());
    }

    #[test]
    fn pnpm_package_directory_links_canonicalize_with_query_and_empty_fragment() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        fs::create_dir_all(f.0.join("node_modules/.pnpm/strip@1/node_modules/strip")).unwrap();
        fs::create_dir_all(f.0.join("node_modules/.pnpm/ansi@1/node_modules/ansi")).unwrap();
        fs::create_dir_all(f.0.join("node_modules/@scope")).unwrap();
        fs::create_dir_all(f.0.join("node_modules/.pnpm/@scope+pkg@1/node_modules/@scope/pkg"))
            .unwrap();
        fs::write(
            f.0.join("node_modules/.pnpm/strip@1/node_modules/strip/index.mjs"),
            "export { value } from 'ansi';",
        )
        .unwrap();
        fs::write(
            f.0.join("node_modules/.pnpm/ansi@1/node_modules/ansi/index.mjs"),
            "export const value = 7;",
        )
        .unwrap();
        fs::write(
            f.0.join("node_modules/.pnpm/@scope+pkg@1/node_modules/@scope/pkg/index.mjs"),
            "export default 8;",
        )
        .unwrap();
        symlink(
            ".pnpm/strip@1/node_modules/strip",
            f.0.join("node_modules/strip"),
        )
        .unwrap();
        symlink(
            "../../ansi@1/node_modules/ansi",
            f.0.join("node_modules/.pnpm/strip@1/node_modules/ansi"),
        )
        .unwrap();
        symlink(
            "../.pnpm/@scope+pkg@1/node_modules/@scope/pkg",
            f.0.join("node_modules/@scope/pkg"),
        )
        .unwrap();
        let mut store = SourceStore::with_workspace_root(&f.0, SourceAdmission::default()).unwrap();
        let strip = store
            .read_resource("app://workspace/node_modules/strip/index.mjs?x=1#")
            .unwrap()
            .unwrap();
        assert_eq!(
            strip.canonical_url,
            "app://workspace/node_modules/.pnpm/strip@1/node_modules/strip/index.mjs?x=1#"
        );
        let ansi = store
            .read_resource("app://workspace/node_modules/.pnpm/strip@1/node_modules/ansi/index.mjs")
            .unwrap()
            .unwrap();
        assert_eq!(
            ansi.canonical_url,
            "app://workspace/node_modules/.pnpm/ansi@1/node_modules/ansi/index.mjs"
        );
        let scoped = store
            .read_resource("app://workspace/node_modules/@scope/pkg/index.mjs")
            .unwrap()
            .unwrap();
        assert_eq!(
            scoped.canonical_url,
            "app://workspace/node_modules/.pnpm/@scope+pkg@1/node_modules/@scope/pkg/index.mjs"
        );
        assert_eq!(
            store
                .read("app://workspace/node_modules/strip/index.mjs")
                .unwrap(),
            None
        );
    }

    #[test]
    fn package_links_reject_escape_cycle_file_links_and_private_aliases() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        fs::create_dir_all(f.0.join("node_modules/.pnpm/pkg@1/node_modules/pkg")).unwrap();
        fs::create_dir_all(f.0.join("node_modules")).unwrap();
        fs::write(
            f.0.join("node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs"),
            "export default 1;",
        )
        .unwrap();
        symlink(".pnpm/pkg@1/node_modules/pkg", f.0.join("node_modules/pkg")).unwrap();
        symlink("/tmp", f.0.join("node_modules/absolute")).unwrap();
        symlink("../../../outside", f.0.join("node_modules/escape")).unwrap();
        symlink("cycle-b", f.0.join("node_modules/cycle-a")).unwrap();
        symlink("cycle-a", f.0.join("node_modules/cycle-b")).unwrap();
        symlink(
            "node_modules/.pnpm/pkg@1/node_modules/pkg",
            f.0.join("not-package"),
        )
        .unwrap();
        symlink(
            "index.mjs",
            f.0.join("node_modules/.pnpm/pkg@1/node_modules/pkg/file-link.mjs"),
        )
        .unwrap();
        let admission = SourceAdmission::default();
        let mut store = SourceStore::with_workspace_root(&f.0, admission.clone()).unwrap();
        for url in [
            "app://workspace/node_modules/absolute/index.mjs",
            "app://workspace/node_modules/escape/index.mjs",
            "app://workspace/node_modules/cycle-a/index.mjs",
            "app://workspace/not-package/index.mjs",
            "app://workspace/node_modules/pkg/file-link.mjs",
            "app://workspace/node_modules/pkg/index.mjs#nonempty",
        ] {
            assert!(store.read_resource(url).is_err(), "{url}");
        }
        let target =
            f.0.join("node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs");
        admission
            .capture(&target, &File::open(&target).unwrap())
            .unwrap();
        store.after_open = Some(Box::new(|| panic!("private target opened")));
        assert!(
            store
                .read_resource("app://workspace/node_modules/pkg/index.mjs")
                .is_err()
        );
        assert!(store.after_open.is_some());
        let alias = f.0.join("node_modules/pkg/index.mjs");
        let fresh = SourceAdmission::default();
        fresh.reserve_namespace(&alias).unwrap();
        let mut store = SourceStore::with_workspace_root(&f.0, fresh).unwrap();
        store.after_open = Some(Box::new(|| panic!("private alias opened")));
        assert!(
            store
                .read_resource("app://workspace/node_modules/pkg/index.mjs")
                .is_err()
        );
        assert!(store.after_open.is_some());
        let private = f.0.join("private/host.json");
        let hardlink_admission = SourceAdmission::default();
        hardlink_admission
            .capture(&private, &File::open(&private).unwrap())
            .unwrap();
        fs::remove_file(&target).unwrap();
        fs::hard_link(&private, &target).unwrap();
        let mut store = SourceStore::with_workspace_root(&f.0, hardlink_admission).unwrap();
        assert!(
            store
                .read_resource("app://workspace/node_modules/pkg/index.mjs")
                .is_err()
        );
    }

    #[test]
    fn alias_allowlist_is_checked_before_cache_and_retarget_keeps_pinned_bytes() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        fs::create_dir_all(f.0.join("node_modules/.pnpm/a@1/node_modules/a")).unwrap();
        fs::create_dir_all(f.0.join("node_modules/.pnpm/b@1/node_modules/b")).unwrap();
        fs::write(
            f.0.join("node_modules/.pnpm/a@1/node_modules/a/index.mjs"),
            "export default 'A';",
        )
        .unwrap();
        fs::write(
            f.0.join("node_modules/.pnpm/b@1/node_modules/b/index.mjs"),
            "export default 'B';",
        )
        .unwrap();
        symlink(".pnpm/a@1/node_modules/a", f.0.join("node_modules/a")).unwrap();
        let mut store = SourceStore::with_workspace_root(&f.0, SourceAdmission::default()).unwrap();
        let link = f.0.join("node_modules/a");
        store.after_open = Some(Box::new(move || {
            fs::remove_file(&link).unwrap();
            symlink(".pnpm/b@1/node_modules/b", &link).unwrap();
        }));
        let first = store
            .read_resource("app://workspace/node_modules/a/index.mjs")
            .unwrap()
            .unwrap();
        assert_eq!(
            first.canonical_url,
            "app://workspace/node_modules/.pnpm/a@1/node_modules/a/index.mjs"
        );
        assert_eq!(first.bytes, b"export default 'A';");
        assert_eq!(
            store
                .read_resource("app://workspace/node_modules/a/index.mjs")
                .unwrap(),
            Some(first)
        );
        let mut staged = SourceStore::with_workspace_entry(
            &f.0,
            &f.0.join("entry.mjs"),
            SourceAdmission::default(),
        )
        .unwrap();
        let alias = "app://workspace/node_modules/a/index.mjs".to_string();
        let canonical =
            "app://workspace/node_modules/.pnpm/a@1/node_modules/a/index.mjs".to_string();
        staged
            .restrict_to_urls(vec![
                staged.entry_url.clone(),
                alias.clone(),
                canonical.clone(),
            ])
            .unwrap();
        staged
            .install_aliases(vec![ModuleAlias {
                url: alias.clone(),
                canonical_url: canonical.clone(),
            }])
            .unwrap();
        assert_eq!(
            staged.read_resource(&alias).unwrap().unwrap().canonical_url,
            canonical
        );
        staged.allowed_urls.as_mut().unwrap().remove(&canonical);
        assert_eq!(staged.read_resource(&alias).unwrap(), None);
        assert!(
            staged
                .install_aliases(vec![ModuleAlias {
                    url: canonical.clone(),
                    canonical_url: alias
                }])
                .is_err()
        );
    }

    #[test]
    fn staged_aliases_are_flat_exact_and_preserve_query_identity() {
        let f = Fixture::new();
        fs::write(f.0.join("canonical.mjs"), "export default 5;").unwrap();
        let entry = "app://workspace/entry.mjs".to_string();
        let target = "app://workspace/canonical.mjs?version=1".to_string();
        let alias = "app://workspace/node_modules/pkg/index.mjs?version=1".to_string();
        let second = "app://workspace/node_modules/other/index.mjs?version=1".to_string();
        let build = || {
            let mut store =
                SourceStore::with_workspace_root(&f.0, SourceAdmission::default()).unwrap();
            store.entry_url = entry.clone();
            store
                .restrict_to_urls(vec![
                    entry.clone(),
                    target.clone(),
                    alias.clone(),
                    second.clone(),
                ])
                .unwrap();
            store
        };
        let mut store = build();
        assert!(
            store
                .install_aliases(vec![
                    ModuleAlias {
                        url: alias.clone(),
                        canonical_url: second.clone()
                    },
                    ModuleAlias {
                        url: second.clone(),
                        canonical_url: target.clone()
                    },
                ])
                .is_err()
        );
        let mut store = build();
        assert!(
            store
                .install_aliases(vec![ModuleAlias {
                    url: alias.clone(),
                    canonical_url: "app://workspace/canonical.mjs?version=2".into(),
                }])
                .is_err()
        );
        let mut store = build();
        store
            .install_aliases(vec![
                ModuleAlias {
                    url: alias.clone(),
                    canonical_url: target.clone(),
                },
                ModuleAlias {
                    url: second.clone(),
                    canonical_url: target.clone(),
                },
            ])
            .unwrap();
        let resource = store.read_resource(&alias).unwrap().unwrap();
        assert_eq!(resource.canonical_url, target);
        assert_eq!(resource.bytes, b"export default 5;");
        let other = store.read_resource(&second).unwrap().unwrap();
        assert!(Arc::ptr_eq(&resource, &other));
        assert_eq!(store.total_bytes, resource.bytes.len());
        assert_eq!(store.canonical_resources.len(), 1);
        assert_eq!(
            store
                .read_resource("app://workspace/node_modules/pkg/index.mjs?version=2")
                .unwrap(),
            None
        );
    }
}
