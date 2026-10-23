use crate::{
    MAX_GRAPH_BYTES, MAX_MODULE_BYTES, MAX_MODULES,
    source::{
        ModuleAlias, PrivatePackage, PrivateResourceBudget, PrivateResourceRead, PrivateSourceRoot,
        SourceReadPurpose, private_resource_relative, private_resource_url,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use url::Url;

const MAX_PLUGIN_ROOTS: usize = 16;
const MAX_PLUGIN_USE_BYTES: usize = 4096;
const MAX_PLUGIN_EXPORT_BYTES: usize = 256;
const MAX_PLUGIN_SCHEMA_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostPluginInstallation {
    #[serde(default = "empty_object")]
    pub config: Value,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default = "default_export", rename = "export")]
    pub export_name: String,
    pub id: String,
    #[serde(default)]
    pub integrity: Option<String>,
    #[serde(rename = "use")]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_graph: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimePluginResourceGraph {
    pub schema_version: u32,
    pub root_url: String,
    pub entry_url: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimePluginResourceRoot {
    pub root_path: PathBuf,
    pub device: u64,
    pub inode: u64,
    pub root_url: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reads: Vec<PrivateResourceRead>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<ModuleAlias>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimePluginInstallation {
    pub config: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_schema: Option<Value>,
    pub entry_url: String,
    pub export_name: String,
    pub instance_id: String,
    pub integrity: Option<String>,
    pub root_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_graph: Option<RuntimePluginResourceGraph>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimePluginSourceRoot {
    pub device: u64,
    pub instance_id: String,
    pub inode: u64,
    pub root_path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_root_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub private_relative_paths: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_root: Option<RuntimePluginResourceRoot>,
}

#[derive(Debug, Default)]
pub struct NativePluginSources {
    pub admission: crate::SourceAdmission,
    pub private_sources: Vec<crate::PrivateSource>,
    roots: HashMap<String, PluginSourceRoot>,
    resource_roots: HashMap<String, PrivateSourceRoot>,
    resource_budget: std::sync::Arc<std::sync::Mutex<PrivateResourceBudget>>,
    snapshots: HashMap<String, (String, usize)>,
    snapshot_identities: HashMap<String, (u64, u64)>,
    weak_snapshots: HashSet<String>,
    total_bytes: usize,
    observer_limits: bool,
}

#[derive(Debug)]
struct PluginSourceRoot {
    directory: File,
    path: PathBuf,
    requested_path: Option<PathBuf>,
}

impl NativePluginSources {
    pub fn from_roots(roots: &[RuntimePluginSourceRoot]) -> Result<Self, String> {
        if roots.len() > 128 {
            return Err("Native plugin source roots exceed Host bounds".into());
        }
        let mut output = Self::default();
        for root in roots {
            if !valid_id(&root.instance_id) || !root.root_path.is_absolute() {
                return Err("Native plugin source root is invalid".into());
            }
            let root_path = canonical_directory(&root.root_path)?;
            let directory = open_directory_no_follow(&root_path)
                .map_err(|_| "Native plugin source root is unavailable")?;
            let (device, inode) = directory_identity(&directory)?;
            if device != root.device || inode != root.inode {
                return Err(
                    "Native plugin source root identity changed before private launch".into(),
                );
            }
            if output
                .roots
                .insert(
                    root.instance_id.clone(),
                    PluginSourceRoot {
                        directory,
                        path: root_path,
                        requested_path: root.requested_root_path.clone(),
                    },
                )
                .is_some()
            {
                return Err("Native plugin source root is duplicated".into());
            }
        }
        Ok(output)
    }
    pub(crate) fn restore_package_names(
        &self,
        roots: &[RuntimePluginSourceRoot],
    ) -> Result<(), String> {
        for root in roots {
            if let Some(requested) = &root.requested_root_path {
                if !requested.is_absolute() || root.private_relative_paths.len() > 3 {
                    return Err("Native plugin package aliases are invalid".into());
                }
                for relative in &root.private_relative_paths {
                    if relative.as_os_str().is_empty()
                        || relative
                            .components()
                            .any(|component| !matches!(component, Component::Normal(_)))
                    {
                        return Err("Native plugin package alias path is invalid".into());
                    }
                    self.admission
                        .reserve_namespace(&requested.join(relative))?;
                }
            }
        }
        Ok(())
    }

    pub(crate) fn install_resource_roots(
        &mut self,
        roots: &[RuntimePluginSourceRoot],
    ) -> Result<(), String> {
        for root in roots {
            let Some(binding) = &root.resource_root else {
                continue;
            };
            let mut selected = PrivateSourceRoot::open_with_budget(
                &binding.root_path,
                &binding.root_url,
                self.admission.clone(),
                self.resource_budget.clone(),
            )?;
            if selected.identity()? != (binding.device, binding.inode) {
                return Err("Native plugin resource root identity changed before launch".into());
            }
            if binding.reads.is_empty() {
                let original = self
                    .roots
                    .get(&root.instance_id)
                    .ok_or("Native plugin original source root is unavailable")?;
                let package = PrivatePackage::from_pinned_directory(
                    original
                        .directory
                        .try_clone()
                        .map_err(|_| "Native plugin original source root is unavailable")?,
                    original
                        .requested_path
                        .clone()
                        .unwrap_or_else(|| original.path.clone()),
                    original.path.clone(),
                )?;
                selected.seed_pinned_directory(Arc::new(package))?;
            }
            if !binding.reads.is_empty() {
                selected.restrict_to_snapshot(&binding.reads, &binding.aliases)?;
                for read in binding
                    .reads
                    .iter()
                    .filter(|read| read.url.ends_with("/package.json"))
                    .chain(
                        binding
                            .reads
                            .iter()
                            .filter(|read| !read.url.ends_with("/package.json")),
                    )
                {
                    let resource = selected
                        .read_resource(&read.url)?
                        .ok_or("Native plugin source snapshot is missing")?;
                    if resource.sha256 != read.sha256 || resource.bytes.len() != read.byte_length {
                        return Err("Native plugin source snapshot integrity changed".into());
                    }
                }
            } else if !binding.aliases.is_empty() {
                return Err("Native plugin resource aliases require a source snapshot".into());
            }
            if self
                .resource_roots
                .insert(root.instance_id.clone(), selected)
                .is_some()
            {
                return Err("Native plugin resource root is duplicated".into());
            }
        }
        Ok(())
    }

    pub fn read_resource(&mut self, input: &str) -> Result<Option<String>, String> {
        self.read_resource_with_purpose(input, SourceReadPurpose::Module)
    }

    pub fn read_resource_with_purpose(
        &mut self,
        input: &str,
        purpose: SourceReadPurpose,
    ) -> Result<Option<String>, String> {
        let url = Url::parse(input).map_err(|_| "Invalid native plugin resource URL")?;
        let segments = url
            .path_segments()
            .ok_or("Invalid native plugin resource URL")?
            .collect::<Vec<_>>();
        let instance_id = segments
            .first()
            .ok_or("Invalid native plugin resource URL")?;
        let root = self
            .resource_roots
            .get_mut(*instance_id)
            .ok_or("Native plugin resource root is not admitted")?;
        let Some(resource) = root.read_resource_with_purpose(input, purpose)? else {
            return Ok(None);
        };
        Ok(Some(
            json!({
                "bytes": &resource.bytes,
                "sha256": &resource.sha256,
                "canonicalUrl": &resource.canonical_url,
            })
            .to_string(),
        ))
    }
    pub(crate) fn apply_observer_limits(&mut self) {
        self.observer_limits = true;
    }

    pub fn read(&mut self, input: &str) -> Result<Option<String>, String> {
        self.read_with_purpose(input, SourceReadPurpose::Module)
    }

    pub fn read_with_purpose(
        &mut self,
        input: &str,
        purpose: SourceReadPurpose,
    ) -> Result<Option<String>, String> {
        self.read_with_limit_and_purpose(
            input,
            if self.observer_limits {
                1024 * 1024
            } else {
                MAX_MODULE_BYTES
            },
            purpose,
        )
    }

    pub fn read_with_limit(&mut self, input: &str, maximum: u64) -> Result<Option<String>, String> {
        self.read_with_limit_and_purpose(input, maximum, SourceReadPurpose::Module)
    }

    fn read_with_limit_and_purpose(
        &mut self,
        input: &str,
        maximum: u64,
        purpose: SourceReadPurpose,
    ) -> Result<Option<String>, String> {
        if maximum == 0 || maximum > MAX_MODULE_BYTES {
            return Err("Native plugin module limit is invalid".into());
        }
        let maximum = if self.observer_limits {
            maximum.min(1024 * 1024)
        } else {
            maximum
        };
        let url = Url::parse(input).map_err(|_| "Invalid native plugin module URL")?;
        if url.scheme() != "holo-plugins"
            || url.host_str().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Native plugin module is outside the admitted resource graph".into());
        }
        let segments = url
            .path_segments()
            .ok_or("Invalid native plugin module path")?
            .collect::<Vec<_>>();
        let Some((instance_id, relative)) = segments.split_first() else {
            return Err("Invalid native plugin module path".into());
        };
        if relative.is_empty()
            || instance_id.is_empty()
            || relative.iter().any(|part| part.is_empty())
        {
            return Err("Invalid native plugin module path".into());
        }
        let root = self
            .roots
            .get(*instance_id)
            .ok_or("Native plugin module is not admitted")?;
        let relative = relative.iter().fold(PathBuf::new(), |mut path, part| {
            path.push(part);
            path
        });
        if purpose == SourceReadPurpose::PackageMetadata
            && relative.file_name() != Some(std::ffi::OsStr::new("package.json"))
        {
            return Err("Package metadata purpose requires exact package.json".into());
        }
        if let Some((snapshot, length)) = self.snapshots.get(input) {
            if *length as u64 > maximum {
                return Err("Native plugin module exceeds the byte limit".into());
            }
            if purpose == SourceReadPurpose::PackageMetadata || !self.weak_snapshots.contains(input)
            {
                return Ok(Some(snapshot.clone()));
            }
        }
        let parent_path = relative
            .parent()
            .ok_or("Invalid native plugin module path")?;
        let parent = if parent_path.as_os_str().is_empty() {
            root.directory.try_clone()
        } else {
            open_confined(&root.directory, parent_path)
        };
        let parent = match parent {
            Ok(parent) => parent,
            Err(error) => {
                if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) {
                    self.reserve_missing_package_name(root, &relative, None, None, purpose)?;
                    return Ok(None);
                }
                return Err("Native plugin directory is unavailable".into());
            }
        };
        let name = relative
            .file_name()
            .ok_or("Invalid native plugin module path")?;
        let file = match open_confined(&parent, Path::new(name)) {
            Ok(file) => file,
            Err(error) => {
                if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) {
                    self.reserve_missing_package_name(
                        root,
                        &relative,
                        Some(&parent),
                        Some(name),
                        purpose,
                    )?;
                    return Ok(None);
                }
                return Err("Native plugin module is unavailable or not confined".into());
            }
        };
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect native plugin module")?;
        if !metadata.is_file() || metadata.len() > maximum {
            return Err("Native plugin module is not a bounded regular file".into());
        }
        let mut bytes = Vec::new();
        (&file)
            .take(maximum + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read native plugin module")?;
        let existing = self.snapshots.get(input).cloned();
        if bytes.len() as u64 > maximum
            || (existing.is_none()
                && self.total_bytes + bytes.len()
                    > if self.observer_limits {
                        4 * 1024 * 1024
                    } else {
                        MAX_GRAPH_BYTES
                    })
            || (existing.is_none()
                && self.snapshots.len()
                    >= if self.observer_limits {
                        128
                    } else {
                        MAX_MODULES
                    })
        {
            return Err("Native plugin module graph limit exceeded".into());
        }
        std::str::from_utf8(&bytes).map_err(|_| "Native plugin module must be valid UTF-8")?;
        use std::os::unix::fs::MetadataExt;
        let identity = (metadata.dev(), metadata.ino());
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let snapshot = json!({
            "sha256": &sha256,
            "bytes": &bytes
        })
        .to_string();
        if let Some((previous, _)) = &existing
            && (previous != &snapshot || self.snapshot_identities.get(input) != Some(&identity))
        {
            return Err("Native plugin source changed under one identity".into());
        }
        let requested = root
            .requested_path
            .as_ref()
            .unwrap_or(&root.path)
            .join(&relative);
        let resolved = root.path.join(&relative);
        let weak = if purpose == SourceReadPurpose::PackageMetadata {
            self.admission
                .host_package_metadata(&requested, &resolved, &parent, name, &file, &sha256)?
        } else {
            self.admission.host_package_name(
                &requested,
                &resolved,
                Some(&parent),
                Some(name),
                Some(&file),
            )?;
            false
        };
        if existing.is_none() {
            self.total_bytes += bytes.len();
            self.snapshot_identities.insert(input.into(), identity);
            self.snapshots
                .insert(input.into(), (snapshot.clone(), bytes.len()));
        }
        if weak {
            self.weak_snapshots.insert(input.into());
        } else {
            self.weak_snapshots.remove(input);
        }
        Ok(Some(snapshot))
    }

    fn reserve_missing_package_name(
        &self,
        root: &PluginSourceRoot,
        relative: &Path,
        parent: Option<&File>,
        name: Option<&std::ffi::OsStr>,
        purpose: SourceReadPurpose,
    ) -> Result<(), String> {
        if let Some(requested) = &root.requested_path {
            if purpose == SourceReadPurpose::Module {
                self.admission.host_package_name(
                    &requested.join(relative),
                    &root.path.join(relative),
                    parent,
                    name,
                    None,
                )?;
            } else {
                self.admission.reserve_missing_package_metadata(
                    &requested.join(relative),
                    &root.path.join(relative),
                    parent,
                    name,
                )?;
            }
        } else if purpose == SourceReadPurpose::PackageMetadata {
            self.admission.reserve_missing_package_metadata(
                &root.path.join(relative),
                &root.path.join(relative),
                parent,
                name,
            )?;
        }
        Ok(())
    }
}

pub struct PreparedNativePlugins {
    pub installations: Vec<RuntimePluginInstallation>,
    pub roots: Vec<RuntimePluginSourceRoot>,
    pub sources: NativePluginSources,
}

pub fn prepare_native_plugins(
    installations: &[HostPluginInstallation],
    allowed_absolute_roots: &[PathBuf],
    config_directory: &Path,
) -> Result<PreparedNativePlugins, String> {
    prepare_native_plugins_with_admission(
        installations,
        allowed_absolute_roots,
        config_directory,
        crate::SourceAdmission::default(),
    )
}

pub(crate) fn prepare_native_plugins_with_admission(
    installations: &[HostPluginInstallation],
    allowed_absolute_roots: &[PathBuf],
    config_directory: &Path,
    admission: crate::SourceAdmission,
) -> Result<PreparedNativePlugins, String> {
    if installations.len() > 128 || allowed_absolute_roots.len() > MAX_PLUGIN_ROOTS {
        return Err("Native plugin configuration exceeds Host bounds".into());
    }
    let config_directory = canonical_directory(config_directory)?;
    let allowed_absolute_roots = allowed_absolute_roots
        .iter()
        .map(|root| canonical_directory(root))
        .collect::<Result<Vec<_>, _>>()?;
    let mut ids = std::collections::HashSet::new();
    let mut output = Vec::new();
    let mut roots = Vec::new();
    let mut sources = NativePluginSources {
        admission,
        ..Default::default()
    };
    for installation in installations.iter().filter(|item| item.enabled) {
        if !valid_id(&installation.id)
            || !ids.insert(&installation.id)
            || !valid_export(&installation.export_name)
            || installation.source.is_empty()
            || installation.source.len() > MAX_PLUGIN_USE_BYTES
            || installation
                .integrity
                .as_deref()
                .is_some_and(|value| !valid_sha256(value))
        {
            return Err("Native plugin installation is invalid or duplicated".into());
        }
        if installation.source_graph.is_some() {
            let (module, binding) =
                prepare_native_plugin_sidecar(installation, &config_directory, &mut sources)?;
            output.push(module);
            roots.push(binding);
            continue;
        }
        let ResolvedPluginSource {
            root,
            entry,
            config_schema,
            read_root_identity,
            requested_root,
            private_relative_paths,
        } = resolve_plugin_source(
            &installation.source,
            &config_directory,
            &allowed_absolute_roots,
            &installation.id,
            &mut sources,
        )?;
        let relative = entry
            .strip_prefix(&root)
            .map_err(|_| "Native plugin entry escapes its source root")?
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        if relative.is_empty() || relative.starts_with("../") {
            return Err("Native plugin entry escapes its source root".into());
        }
        let root_url = format!("holo-plugins:///{}/", installation.id);
        let directory = open_directory_no_follow(&root)
            .map_err(|_| "Native plugin source root is unavailable")?;
        let (device, inode) = directory_identity(&directory)?;
        ensure_root_identity(read_root_identity, (device, inode))?;
        let entry_file = open_confined(&directory, Path::new(&relative))
            .map_err(|_| "Native plugin entry is unavailable")?;
        sources
            .private_sources
            .push(sources.admission.capture(&entry, &entry_file)?);
        sources.roots.insert(
            installation.id.clone(),
            PluginSourceRoot {
                directory,
                path: root.clone(),
                requested_path: requested_root.clone(),
            },
        );
        roots.push(RuntimePluginSourceRoot {
            device,
            instance_id: installation.id.clone(),
            inode,
            root_path: root,
            requested_root_path: requested_root,
            private_relative_paths,
            resource_root: None,
        });
        output.push(RuntimePluginInstallation {
            config: installation.config.clone(),
            config_schema,
            entry_url: format!("{root_url}{relative}"),
            export_name: installation.export_name.clone(),
            instance_id: installation.id.clone(),
            integrity: installation.integrity.clone(),
            root_url: root_url.clone(),
            resource_graph: None,
        });
        let selected_root = std::iter::once(&config_directory)
            .chain(allowed_absolute_roots.iter())
            .filter(|selected| entry.starts_with(selected.as_path()))
            .max_by_key(|selected| selected.components().count());
        if let Some(selected_root) = selected_root {
            let mut resource = PrivateSourceRoot::open_with_budget(
                selected_root,
                &root_url,
                sources.admission.clone(),
                sources.resource_budget.clone(),
            )?;
            let original = sources
                .roots
                .get(&installation.id)
                .ok_or("Native plugin original source root is unavailable")?;
            let package = PrivatePackage::from_pinned_directory(
                original
                    .directory
                    .try_clone()
                    .map_err(|_| "Native plugin original source root is unavailable")?,
                original
                    .requested_path
                    .clone()
                    .unwrap_or_else(|| original.path.clone()),
                original.path.clone(),
            )?;
            resource.seed_pinned_directory(Arc::new(package))?;
            let (resource_device, resource_inode) = resource.identity()?;
            let relative_entry = entry
                .strip_prefix(selected_root)
                .map_err(|_| "Native plugin entry escapes selected resource root")?;
            let entry_url = private_resource_url(&root_url, relative_entry)?;
            let module = output
                .last_mut()
                .ok_or("Native plugin installation is unavailable")?;
            module.resource_graph = Some(RuntimePluginResourceGraph {
                schema_version: 2,
                root_url: root_url.clone(),
                entry_url,
                required: false,
            });
            roots
                .last_mut()
                .ok_or("Native plugin source root is unavailable")?
                .resource_root = Some(RuntimePluginResourceRoot {
                root_path: selected_root.to_path_buf(),
                device: resource_device,
                inode: resource_inode,
                root_url: root_url.clone(),
                reads: Vec::new(),
                aliases: Vec::new(),
            });
            if sources
                .resource_roots
                .insert(installation.id.clone(), resource)
                .is_some()
            {
                return Err("Native plugin resource root is duplicated".into());
            }
        }
    }
    Ok(PreparedNativePlugins {
        installations: output,
        roots,
        sources,
    })
}

fn empty_object() -> Value {
    json!({})
}
fn enabled() -> bool {
    true
}
fn is_false(value: &bool) -> bool {
    !*value
}
fn default_export() -> String {
    "default".into()
}
pub(crate) fn valid_id(value: &str) -> bool {
    value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || byte == b'_'
                || byte == b'.'
                || byte == b'-' && index > 0
        })
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
}
fn valid_export(value: &str) -> bool {
    value.len() <= MAX_PLUGIN_EXPORT_BYTES
        && value
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_' || *byte == b'$')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$')
}
fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

struct ResolvedPluginSource {
    root: PathBuf,
    entry: PathBuf,
    config_schema: Option<Value>,
    read_root_identity: Option<(u64, u64)>,
    requested_root: Option<PathBuf>,
    private_relative_paths: Vec<PathBuf>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativePluginSourceGraphSidecar {
    schema_version: u32,
    instance_id: String,
    root_url: String,
    entry_url: String,
    bundle_sha256: String,
    #[serde(default)]
    config_schema: Option<Value>,
    reads: Vec<PrivateResourceRead>,
    aliases: Vec<ModuleAlias>,
    external_references: Vec<Value>,
}

fn prepare_native_plugin_sidecar(
    installation: &HostPluginInstallation,
    config_directory: &Path,
    sources: &mut NativePluginSources,
) -> Result<(RuntimePluginInstallation, RuntimePluginSourceRoot), String> {
    let locator = installation
        .source_graph
        .as_deref()
        .ok_or("Native plugin source graph locator is missing")?;
    if locator.len() > MAX_PLUGIN_USE_BYTES
        || !locator.starts_with("./")
        || !locator.ends_with("/source-graph.json")
    {
        return Err("Native plugin source graph locator is invalid".into());
    }
    let sidecar_path = confined_config_path(config_directory, Path::new(locator))?;
    let graph_dir = sidecar_path
        .parent()
        .ok_or("Native plugin graph parent is missing")?;
    let source_root_path = canonical_directory(&graph_dir.join("sources"))?;
    let directory = open_directory_no_follow(config_directory)
        .map_err(|_| "Native plugin config root is unavailable")?;
    let relative_sidecar = sidecar_path
        .strip_prefix(config_directory)
        .map_err(|_| "Native plugin source graph escapes its config root")?;
    let mut sidecar_file = open_confined(&directory, relative_sidecar)
        .map_err(|_| "Native plugin source graph is unavailable")?;
    let before = sidecar_file
        .metadata()
        .map_err(|_| "Native plugin source graph is unavailable")?;
    if !before.is_file() || before.len() > 4 * 1024 * 1024 {
        return Err("Native plugin source graph must be a bounded regular file".into());
    }
    sources
        .private_sources
        .push(sources.admission.capture(&sidecar_path, &sidecar_file)?);
    let mut bytes = Vec::new();
    (&mut sidecar_file)
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read native plugin source graph")?;
    let after = sidecar_file
        .metadata()
        .map_err(|_| "Native plugin source graph changed")?;
    if bytes.len() > 4 * 1024 * 1024
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("Native plugin source graph changed".into());
    }
    let sidecar: NativePluginSourceGraphSidecar =
        serde_json::from_slice(&bytes).map_err(|_| "Native plugin source graph is invalid")?;
    let raw_sidecar: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Native plugin source graph is invalid")?;
    let root_url = format!("holo-plugins:///{}/", installation.id);
    if sidecar.schema_version != 2
        || sidecar.instance_id != installation.id
        || sidecar.root_url != root_url
        || installation.integrity.as_deref() != Some(sidecar.bundle_sha256.as_str())
        || !valid_sha256(&sidecar.bundle_sha256)
        || !sidecar.external_references.is_empty()
        || sidecar.reads.is_empty()
        || sidecar.reads.len() > MAX_MODULES
        || sidecar.aliases.len() > MAX_MODULES
        || sidecar
            .reads
            .windows(2)
            .any(|pair| pair[0].url >= pair[1].url)
        || sidecar
            .aliases
            .windows(2)
            .any(|pair| pair[0].url >= pair[1].url)
        || raw_sidecar.get("configSchema").is_some_and(Value::is_null)
        || sidecar.config_schema.as_ref().is_some_and(|schema| {
            (!schema.is_object() && !schema.is_boolean())
                || serde_json::to_vec(schema)
                    .is_ok_and(|bytes| bytes.len() > MAX_PLUGIN_SCHEMA_BYTES as usize)
        })
    {
        return Err("Native plugin source graph metadata is invalid".into());
    }
    let entry_relative = private_resource_relative(&root_url, &sidecar.entry_url)?;
    let mut physical_names = std::collections::HashSet::new();
    for read in &sidecar.reads {
        let relative = private_resource_relative(&root_url, &read.url)?;
        if !physical_names.insert(relative.to_string_lossy().to_lowercase()) {
            return Err("Native plugin source graph has colliding physical paths".into());
        }
    }
    for alias in &sidecar.aliases {
        let relative = private_resource_relative(&root_url, &alias.url)?;
        if !physical_names.insert(relative.to_string_lossy().to_lowercase()) {
            return Err("Native plugin source graph alias collides with a physical path".into());
        }
    }
    if !sidecar
        .reads
        .iter()
        .any(|read| read.url == sidecar.entry_url)
    {
        return Err("Native plugin source graph entry is missing".into());
    }
    let expected_entry = source_root_path.join(&entry_relative);
    let source = confined_config_path(config_directory, Path::new(&installation.source))?;
    if source != expected_entry {
        return Err("Native plugin source graph entry path is inconsistent".into());
    }
    let mut resource = PrivateSourceRoot::open_with_budget(
        &source_root_path,
        &root_url,
        sources.admission.clone(),
        sources.resource_budget.clone(),
    )?;
    let (resource_device, resource_inode) = resource.identity()?;
    resource.restrict_to_snapshot(&sidecar.reads, &sidecar.aliases)?;
    for read in sidecar
        .reads
        .iter()
        .filter(|read| read.url.ends_with("/package.json"))
        .chain(
            sidecar
                .reads
                .iter()
                .filter(|read| !read.url.ends_with("/package.json")),
        )
    {
        let selected = resource
            .read_resource(&read.url)?
            .ok_or("Native plugin source graph file is missing")?;
        if selected.bytes.len() != read.byte_length || selected.sha256 != read.sha256 {
            return Err("Native plugin source graph file changed".into());
        }
    }
    let entry_file = open_confined(
        &open_directory_no_follow(&source_root_path)
            .map_err(|_| "Native plugin source root is unavailable")?,
        &entry_relative,
    )
    .map_err(|_| "Native plugin source graph entry is unavailable")?;
    sources
        .private_sources
        .push(sources.admission.capture(&expected_entry, &entry_file)?);
    if sources
        .resource_roots
        .insert(installation.id.clone(), resource)
        .is_some()
    {
        return Err("Native plugin resource root is duplicated".into());
    }
    let source_dir = open_directory_no_follow(&source_root_path)
        .map_err(|_| "Native plugin source root is unavailable")?;
    let (device, inode) = directory_identity(&source_dir)?;
    sources.roots.insert(
        installation.id.clone(),
        PluginSourceRoot {
            directory: source_dir,
            path: source_root_path.clone(),
            requested_path: None,
        },
    );
    let module = RuntimePluginInstallation {
        config: installation.config.clone(),
        config_schema: sidecar.config_schema,
        entry_url: sidecar.entry_url.clone(),
        export_name: installation.export_name.clone(),
        instance_id: installation.id.clone(),
        integrity: installation.integrity.clone(),
        root_url: root_url.clone(),
        resource_graph: Some(RuntimePluginResourceGraph {
            schema_version: 2,
            root_url: root_url.clone(),
            entry_url: sidecar.entry_url,
            required: true,
        }),
    };
    let root = RuntimePluginSourceRoot {
        device,
        instance_id: installation.id.clone(),
        inode,
        root_path: source_root_path.clone(),
        requested_root_path: None,
        private_relative_paths: Vec::new(),
        resource_root: Some(RuntimePluginResourceRoot {
            root_path: source_root_path,
            device: resource_device,
            inode: resource_inode,
            root_url,
            reads: sidecar.reads,
            aliases: sidecar.aliases,
        }),
    };
    Ok((module, root))
}

fn resolve_plugin_source(
    source: &str,
    config_directory: &Path,
    allowed_absolute_roots: &[PathBuf],
    id: &str,
    sources: &mut NativePluginSources,
) -> Result<ResolvedPluginSource, String> {
    if source.starts_with("file:") {
        return Err("Native plugin file: URLs are unsupported".into());
    }
    let relative = source.starts_with("./") || source.starts_with("../");
    let absolute = Path::new(source).is_absolute();
    let target = if relative {
        if let Some(name) = explicit_config_root_package_name(source)
            && let Some(package) =
                resolve_selected_root_package(name, config_directory, id, sources)?
        {
            return Ok(package);
        }
        relative_config_path(config_directory, Path::new(source))?
    } else if absolute {
        let candidate = PathBuf::from(source);
        let (root, relative) = selected_absolute_root(&candidate, allowed_absolute_roots)
            .ok_or_else(|| format!("Absolute native plugin source is not allowed: {id}"))?;
        if let Some(name) = relative.to_str().and_then(explicit_root_package_name)
            && let Some(package) = resolve_selected_root_package(name, root, id, sources)?
        {
            return Ok(package);
        }
        confined_config_path(root, &relative)?
    } else {
        if let Some(package) = resolve_selected_root_package(source, config_directory, id, sources)?
        {
            return Ok(package);
        }
        find_package(source, config_directory)?
    };
    let metadata =
        fs::symlink_metadata(&target).map_err(|_| "Native plugin source is unavailable")?;
    if metadata.file_type().is_symlink() {
        return Err("Native plugin source must not be a symbolic link".into());
    }
    if metadata.is_file()
        && target
            .file_name()
            .is_some_and(|name| name != "package.json")
    {
        return Ok(ResolvedPluginSource {
            root: canonical_directory(
                target
                    .parent()
                    .ok_or("Native plugin source has no parent")?,
            )?,
            entry: canonical_regular_file(&target)?,
            config_schema: None,
            read_root_identity: None,
            requested_root: None,
            private_relative_paths: Vec::new(),
        });
    }
    let manifest = if metadata.is_dir() {
        target.join("package.json")
    } else {
        target
    };
    let manifest = canonical_regular_file(&manifest)?;
    let root = canonical_directory(
        manifest
            .parent()
            .ok_or("Native plugin package has no root")?,
    )?;
    let directory =
        open_directory_no_follow(&root).map_err(|_| "Native plugin root is unavailable")?;
    let manifest_root_identity = directory_identity(&directory)?;
    let manifest_file = open_confined(&directory, Path::new("package.json"))
        .map_err(|_| "Native plugin package manifest is unavailable")?;
    sources
        .private_sources
        .push(sources.admission.capture(&manifest, &manifest_file)?);
    let mut manifest_bytes = Vec::new();
    manifest_file
        .take(MAX_PLUGIN_SCHEMA_BYTES + 1)
        .read_to_end(&mut manifest_bytes)
        .map_err(|_| "Cannot read native plugin manifest")?;
    if manifest_bytes.len() as u64 > MAX_PLUGIN_SCHEMA_BYTES {
        return Err("Native plugin manifest exceeds byte limit".into());
    }
    let (entry, schema_path) = package_descriptor(&manifest_bytes, id)?;
    let (config_schema, read_root_identity) = match schema_path {
        None => (None, Some(manifest_root_identity)),
        Some(path) => {
            let schema_path = confined_config_path(&root, Path::new(&path))?;
            let relative = schema_path
                .strip_prefix(&root)
                .map_err(|_| "Native plugin config Schema escapes its source root")?;
            let (schema, identity) = read_confined_schema(&root, relative, sources)?;
            ensure_root_identity(Some(manifest_root_identity), identity)?;
            (Some(schema), Some(identity))
        }
    };
    Ok(ResolvedPluginSource {
        root: root.clone(),
        entry: confined_config_path(&root, Path::new(&entry))?,
        config_schema,
        read_root_identity,
        requested_root: None,
        private_relative_paths: Vec::new(),
    })
}

fn package_descriptor(bytes: &[u8], id: &str) -> Result<(String, Option<String>), String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| "Native plugin package manifest is invalid")?;
    let holo = value
        .get("holo")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("Native plugin package manifest is invalid: {id}"))?;
    if holo.get("kind").and_then(Value::as_str) != Some("runtime-plugin")
        || holo.get("apiVersion").and_then(Value::as_u64) != Some(1)
    {
        return Err(format!(
            "Native plugin package manifest is unsupported: {id}"
        ));
    }
    let entry = holo
        .get("entry")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Native plugin package manifest is invalid: {id}"))?;
    let schema = match holo.get("configSchema") {
        None | Some(Value::Null) => None,
        Some(Value::String(path)) if !path.is_empty() => Some(path.to_owned()),
        _ => return Err(format!("Native plugin package manifest is invalid: {id}")),
    };
    Ok((entry.into(), schema))
}

/// The caller selects one already admitted root. A package-directory link may
/// resolve only within that root; the parent search remains strictly physical.
fn resolve_selected_root_package(
    source: &str,
    selected_root: &Path,
    id: &str,
    sources: &mut NativePluginSources,
) -> Result<Option<ResolvedPluginSource>, String> {
    if !valid_package_name(source) {
        return Ok(None);
    }
    let requested_package = selected_root.join("node_modules").join(source);
    match fs::symlink_metadata(&requested_package) {
        Ok(metadata) if metadata.file_type().is_symlink() => {}
        Ok(_) => return Ok(None),
        Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => {
            return Ok(None);
        }
        Err(_) => return Err("Native plugin package is unavailable".into()),
    }
    let requested_manifest = requested_package.join("package.json");
    let Some((package, manifest)) =
        PrivatePackage::open(selected_root, &requested_manifest, &sources.admission)?
    else {
        return Err("Native plugin package manifest is unavailable".into());
    };
    let root = package.root_path().to_path_buf();
    let root_identity = directory_identity(package.directory())?;
    sources.private_sources.push(
        sources
            .admission
            .capture(&root.join("package.json"), &manifest)?,
    );
    let mut bytes = Vec::new();
    manifest
        .take(MAX_PLUGIN_SCHEMA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read native plugin manifest")?;
    if bytes.len() as u64 > MAX_PLUGIN_SCHEMA_BYTES {
        return Err("Native plugin manifest exceeds byte limit".into());
    }
    let (entry, schema) = package_descriptor(&bytes, id)?;
    let entry_relative = package_inner_relative(&entry)?;
    let entry_file = package
        .read(&entry_relative, &sources.admission)?
        .ok_or("Native plugin entry is unavailable")?;
    if !entry_file
        .metadata()
        .map_err(|_| "Cannot inspect native plugin entry")?
        .is_file()
    {
        return Err("Native plugin entry must be a regular file".into());
    }
    let mut private_relative_paths = vec![PathBuf::from("package.json"), entry_relative.clone()];
    let config_schema = if let Some(schema) = schema {
        let relative = package_inner_relative(&schema)?;
        let file = package
            .read(&relative, &sources.admission)?
            .ok_or("Native plugin config Schema is unavailable")?;
        sources
            .private_sources
            .push(sources.admission.capture(&root.join(&relative), &file)?);
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect native plugin config Schema")?;
        if !metadata.is_file() || metadata.len() > MAX_PLUGIN_SCHEMA_BYTES {
            return Err("Native plugin config Schema is not a bounded regular file".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_PLUGIN_SCHEMA_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read native plugin config Schema")?;
        if bytes.len() as u64 > MAX_PLUGIN_SCHEMA_BYTES {
            return Err("Native plugin config Schema exceeds the byte limit".into());
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Native plugin config Schema is not valid JSON")?;
        if !value.is_object() && !value.is_boolean() {
            return Err("Native plugin config Schema must be an object or boolean".into());
        }
        private_relative_paths.push(relative);
        Some(value)
    } else {
        None
    };
    let requested_root = (package.requested_root() != package.root_path())
        .then(|| package.requested_root().to_path_buf());
    Ok(Some(ResolvedPluginSource {
        root: root.clone(),
        entry: root.join(entry_relative),
        config_schema,
        read_root_identity: Some(root_identity),
        requested_root,
        private_relative_paths,
    }))
}

fn package_inner_relative(value: &str) -> Result<PathBuf, String> {
    let value = value.strip_prefix("./").unwrap_or(value);
    if value.is_empty()
        || value.len() > MAX_PLUGIN_USE_BYTES
        || value.contains(['\\', '\0', '%', '?', '#'])
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Native plugin package path is invalid".into());
    }
    Ok(PathBuf::from(value))
}

fn valid_package_name(source: &str) -> bool {
    let parts = source.split('/').collect::<Vec<_>>();
    let valid_part = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-._~".contains(&byte))
    };
    match parts.as_slice() {
        [name] => valid_part(name) && !name.starts_with('@'),
        [scope, name] => scope.starts_with('@') && valid_part(&scope[1..]) && valid_part(name),
        _ => false,
    }
}

fn explicit_config_root_package_name(source: &str) -> Option<&str> {
    explicit_root_package_name(source.strip_prefix("./")?)
}

fn explicit_root_package_name(source: &str) -> Option<&str> {
    let suffix = source.strip_prefix("node_modules/")?;
    let name = suffix.strip_suffix("/package.json").unwrap_or(suffix);
    valid_package_name(name).then_some(name)
}

fn selected_absolute_root<'a>(
    candidate: &Path,
    allowed_roots: &'a [PathBuf],
) -> Option<(&'a Path, PathBuf)> {
    if !candidate.is_absolute() || candidate.components().count() > 256 {
        return None;
    }
    let mut spellings = vec![candidate.to_path_buf()];
    #[cfg(target_os = "macos")]
    if let Ok(relative) = candidate.strip_prefix("/var")
        && trusted_macos_var_alias()
    {
        spellings.push(Path::new("/private/var").join(relative));
    }
    let mut selected: Option<(&PathBuf, PathBuf)> = None;
    for spelling in &spellings {
        for root in allowed_roots {
            if let Ok(relative) = spelling.strip_prefix(root)
                && selected.as_ref().is_none_or(|(previous, _)| {
                    root.components().count() > previous.components().count()
                })
            {
                selected = Some((root, relative.into()));
            }
        }
    }
    selected.map(|(root, relative)| (root.as_path(), relative))
}

#[cfg(target_os = "macos")]
pub(crate) fn trusted_macos_var_alias() -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(link) = fs::symlink_metadata("/var") else {
        return false;
    };
    if !link.file_type().is_symlink() || link.uid() != 0 {
        return false;
    }
    for parent in ["/", "/private", "/private/var"] {
        let Ok(metadata) = fs::symlink_metadata(parent) else {
            return false;
        };
        if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return false;
        }
    }
    fs::canonicalize("/var").ok().as_deref() == Some(Path::new("/private/var"))
}

/// Read the manifest-declared Schema through the admitted root descriptor so a
/// symlink replacement cannot make validation consume a file outside the
/// plugin.  The parsed JSON is then carried in the private launch snapshot;
/// JavaScript compiles that immutable value before it admits a graph.
fn read_confined_schema(
    root_path: &Path,
    relative: &Path,
    sources: &mut NativePluginSources,
) -> Result<(Value, (u64, u64)), String> {
    let root = open_directory_no_follow(root_path)
        .map_err(|_| "Native plugin config Schema is unavailable or not confined")?;
    let identity = directory_identity(&root)?;
    let file = open_confined(&root, relative)
        .map_err(|_| "Native plugin config Schema is unavailable or not confined")?;
    sources.private_sources.push(
        sources
            .admission
            .capture(&root_path.join(relative), &file)?,
    );
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect native plugin config Schema")?;
    if !metadata.is_file() || metadata.len() > MAX_PLUGIN_SCHEMA_BYTES {
        return Err("Native plugin config Schema is not a bounded regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_PLUGIN_SCHEMA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read native plugin config Schema")?;
    if bytes.len() as u64 > MAX_PLUGIN_SCHEMA_BYTES {
        return Err("Native plugin config Schema exceeds the byte limit".into());
    }
    let schema: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Native plugin config Schema is not valid JSON")?;
    if !schema.is_object() && !schema.is_boolean() {
        return Err("Native plugin config Schema must be an object or boolean".into());
    }
    Ok((schema, identity))
}

fn ensure_root_identity(read: Option<(u64, u64)>, retained: (u64, u64)) -> Result<(), String> {
    if read.is_some_and(|identity| identity != retained) {
        Err("Native plugin source root changed during admission".into())
    } else {
        Ok(())
    }
}

fn find_package(source: &str, config_directory: &Path) -> Result<PathBuf, String> {
    if source.starts_with('.') || source.contains('\\') || source.contains('\0') {
        return Err("Native plugin package name is invalid".into());
    }
    let mut directory = config_directory.to_path_buf();
    loop {
        let candidate = directory
            .join("node_modules")
            .join(source)
            .join("package.json");
        if candidate.exists() {
            return confined_config_path(
                &directory,
                candidate
                    .strip_prefix(&directory)
                    .map_err(|_| "Invalid native plugin package")?,
            );
        }
        if !directory.pop() {
            break;
        }
    }
    Err(format!(
        "Native plugin package manifest is unavailable: {source}"
    ))
}

fn confined_config_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    if relative.is_absolute() {
        return Err("Native plugin path must be relative to an admitted root".into());
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let part = match component {
            Component::CurDir => continue,
            Component::Normal(part) => part,
            _ => return Err("Native plugin source escapes its admitted root".into()),
        };
        current.push(part);
        let metadata =
            fs::symlink_metadata(&current).map_err(|_| "Native plugin source is unavailable")?;
        if metadata.file_type().is_symlink() {
            return Err("Native plugin source must not be a symbolic link".into());
        }
    }
    Ok(current)
}

fn relative_config_path(base: &Path, relative: &Path) -> Result<PathBuf, String> {
    if relative.is_absolute() {
        return Err("Native plugin path must be relative to the Host configuration".into());
    }
    let mut current = base.to_path_buf();
    for component in relative.components() {
        match component {
            Component::CurDir => continue,
            Component::ParentDir => {
                current.pop();
            }
            Component::Normal(part) => {
                current.push(part);
                let metadata = fs::symlink_metadata(&current)
                    .map_err(|_| "Native plugin source is unavailable")?;
                if metadata.file_type().is_symlink() {
                    return Err("Native plugin source must not be a symbolic link".into());
                }
            }
            _ => return Err("Native plugin source is invalid".into()),
        }
    }
    Ok(current)
}

fn canonical_regular_file(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Native plugin source is unavailable")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Native plugin source must be a regular file".into());
    }
    path.canonicalize()
        .map_err(|_| "Native plugin source is unavailable".into())
}
fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Native plugin source is unavailable")?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Native plugin source root must be a directory".into());
    }
    path.canonicalize()
        .map_err(|_| "Native plugin source root is unavailable".into())
}

#[cfg(unix)]
fn directory_identity(directory: &File) -> Result<(u64, u64), String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = directory
        .metadata()
        .map_err(|_| "Native plugin source root is unavailable")?;
    if !metadata.is_dir() {
        return Err("Native plugin source root must be a directory".into());
    }
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn directory_identity(_: &File) -> Result<(u64, u64), String> {
    Err("Native plugin source roots are unsupported on this platform".into())
}

#[cfg(unix)]
fn open_directory_no_follow(path: &Path) -> std::io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    if !path.is_absolute() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let mut directory = File::open("/")?;
    for component in path.components() {
        let Component::Normal(part) = component else {
            if matches!(component, Component::RootDir) {
                continue;
            }
            return Err(std::io::ErrorKind::PermissionDenied.into());
        };
        let name = CString::new(part.as_bytes()).map_err(|_| std::io::ErrorKind::InvalidInput)?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | libc::O_DIRECTORY;
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok(directory)
}

#[cfg(not(unix))]
fn open_directory_no_follow(_: &Path) -> std::io::Result<File> {
    Err(std::io::ErrorKind::Unsupported.into())
}

#[cfg(unix)]
fn open_confined(root: &File, relative: &Path) -> std::io::Result<File> {
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
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok(directory)
}

#[cfg(not(unix))]
fn open_confined(_: &File, _: &Path) -> std::io::Result<File> {
    Err(std::io::ErrorKind::Unsupported.into())
}

#[cfg(test)]
#[path = "plugins_tests.rs"]
mod tests;
