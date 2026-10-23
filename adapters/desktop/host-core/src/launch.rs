use crate::{
    HostPluginInstallation, NativePluginSources, ObserverProfileInstallation,
    RuntimeObserverProfileInstallation, RuntimePluginInstallation, RuntimePluginSourceRoot,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::OpenOptions,
    io::{BufRead, Read},
    path::{Path, PathBuf},
};

pub const MAX_LAUNCH_BYTES: u64 = 1024 * 1024;

/// Owner-selected diagnostic capability. The native Host also applies its own
/// smaller, non-configurable source-copy ceiling before crossing threads.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiagnosticSourceReaderInstallation {
    pub capability_name: String,
    pub max_read_bytes: u32,
    pub max_reads: u32,
}

/// Owner-selected, Host-only access to buffered network request bytes.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NetworkRequestBodyReaderInstallation {
    pub capability_name: String,
    pub max_read_bytes: u32,
    pub max_reads: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FilesystemRootInstallation {
    pub root_id: String,
    pub host_path: PathBuf,
}

/// Explicit Host-only selection of the built-in, read-only macOS Device source.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeviceProviderInstallation {
    pub implementation: String,
}

impl DeviceProviderInstallation {
    fn validate(&self) -> Result<(), String> {
        if self.implementation != "builtin.darwin-device-v1"
            || !cfg!(all(target_os = "macos", target_arch = "aarch64"))
        {
            return Err("Invalid Device Provider installation".into());
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HostConfiguration {
    #[serde(default)]
    pub private_sources: Vec<crate::PrivateSource>,
    pub schema_version: u32,
    pub sandbox_policy: Value,
    /// Absent by default. The public Device descriptor cannot select an OS source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_provider: Option<DeviceProviderInstallation>,
    /// Owner-selected persistence; physical namespace and directory are Host-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage: Option<crate::StorageInstallation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_source_reader: Option<DiagnosticSourceReaderInstallation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_audit: Option<crate::DiagnosticAuditInstallation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_request_body_reader: Option<NetworkRequestBodyReaderInstallation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_profile_id: Option<String>,
    /// Host-only profile resolved from an owner-private manifest before launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_profile: Option<Value>,
    /// Host-only Backend installation selected from a separate owner manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_backend_installation: Option<Value>,
    #[serde(default = "empty_context")]
    pub context: Value,
    #[serde(default = "empty_projection")]
    pub system_projection: Value,
    #[serde(default)]
    pub filesystem_roots: Vec<FilesystemRootInstallation>,
    #[serde(default)]
    pub network_rules: Option<Value>,
    #[serde(default)]
    pub network_trust_roots: Vec<String>,
    /// Absolute plugin source roots explicitly admitted by this Host configuration.
    #[serde(default)]
    pub plugin_roots: Vec<PathBuf>,
    /// Declarative cross-platform JavaScript Cordis plugins.  Their source is
    /// resolved and snapshotted by the native Host; it is never exposed to Guest.
    #[serde(default)]
    pub plugins: Vec<HostPluginInstallation>,
    /// Immutable, owner-selected modules for dedicated diagnostic helpers.
    #[serde(default)]
    pub observer_profiles: Vec<ObserverProfileInstallation>,
    #[serde(default, rename = "runtimePlugins")]
    pub runtime_plugins: Vec<RuntimePluginInstallation>,
    #[serde(default, rename = "runtimePluginRoots")]
    pub runtime_plugin_roots: Vec<RuntimePluginSourceRoot>,
    #[serde(default, rename = "runtimeObserverProfiles")]
    pub runtime_observer_profiles: Vec<RuntimeObserverProfileInstallation>,
    #[serde(default, rename = "runtimeObserverRoots")]
    pub runtime_observer_roots: Vec<RuntimePluginSourceRoot>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "pluginGraphRevision"
    )]
    pub plugin_graph_revision: Option<u64>,
    #[serde(skip)]
    pub plugin_sources: NativePluginSources,
    #[serde(skip)]
    pub observer_sources: NativePluginSources,
    #[serde(skip)]
    pub observer_sinks: HashMap<String, crate::NativeObserverSink>,
    #[serde(skip)]
    pub diagnostic_audit_writer: Option<crate::NativeDiagnosticAudit>,
}
fn empty_context() -> Value {
    json!({"schemaVersion":1})
}
fn empty_projection() -> Value {
    json!({"schemaVersion":1,"fields":{}})
}

impl HostConfiguration {
    pub fn read(path: &Path) -> Result<Self, String> {
        Self::read_with_admission(path, crate::SourceAdmission::default())
    }
    pub fn read_with_admission(
        path: &Path,
        admission: crate::SourceAdmission,
    ) -> Result<Self, String> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
        }
        let file = options
            .open(path)
            .map_err(|_| "Host configuration is unavailable")?;
        let metadata = file
            .metadata()
            .map_err(|_| "Host configuration is unavailable")?;
        if !metadata.is_file() || metadata.len() > MAX_LAUNCH_BYTES {
            return Err("Host configuration must be a bounded regular file".into());
        }
        let base = path
            .canonicalize()
            .map_err(|_| "Host configuration is unavailable")?;
        let private_config = admission.capture(&base, &file)?;
        let mut bytes = Vec::new();
        file.take(MAX_LAUNCH_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read Host configuration")?;
        if bytes.len() as u64 > MAX_LAUNCH_BYTES {
            return Err("Host configuration exceeds the byte limit".into());
        }
        let public: Value =
            serde_json::from_slice(&bytes).map_err(|_| "Host configuration has invalid syntax")?;
        if public.get("runtimePlugins").is_some()
            || public.get("runtimePluginRoots").is_some()
            || public.get("runtimeObserverProfiles").is_some()
            || public.get("runtimeObserverRoots").is_some()
            || public.get("pluginGraphRevision").is_some()
            || public.get("privateSources").is_some()
            || public.get("processProfile").is_some()
            || public.get("processBackendInstallation").is_some()
        {
            return Err("Private plugin launch bindings are not Host configuration fields".into());
        }
        let mut config: Self = serde_json::from_value(public)
            .map_err(|_| "Host configuration has invalid syntax or unknown fields")?;
        for root in &mut config.filesystem_roots {
            if root.host_path.is_relative() {
                root.host_path = base
                    .parent()
                    .ok_or("Invalid Host configuration location")?
                    .join(&root.host_path);
            }
        }
        if let Some(storage) = &mut config.storage {
            if storage.directory.is_relative() {
                storage.directory = base
                    .parent()
                    .ok_or("Invalid Host configuration location")?
                    .join(&storage.directory);
            }
            storage.validate()?;
            storage.directory = storage
                .directory
                .canonicalize()
                .map_err(|_| "Host Storage directory is unavailable")?;
        }
        for root in &mut config.plugin_roots {
            if root.is_relative() {
                *root = base
                    .parent()
                    .ok_or("Invalid Host configuration location")?
                    .join(&root);
            }
        }
        if let Some(audit) = config.diagnostic_audit.as_mut()
            && audit.path.is_relative()
        {
            audit.path = base
                .parent()
                .ok_or("Invalid Host configuration location")?
                .join(&audit.path);
        }
        for profile in &mut config.observer_profiles {
            if profile.sink.path.is_absolute() {
                return Err("Observer sink path must be relative to Host configuration".into());
            }
            let path = base
                .parent()
                .ok_or("Invalid Host configuration location")?
                .join(&profile.sink.path);
            profile.sink.path = path.components().collect();
        }
        config.validate()?;
        let mut prepared = crate::plugins::prepare_native_plugins_with_admission(
            &config.plugins,
            &config.plugin_roots,
            base.parent().ok_or("Invalid Host configuration location")?,
            admission.clone(),
        )?;
        let mut observers = crate::observer_profiles::prepare_observer_profiles(
            &config.observer_profiles,
            &config.plugin_roots,
            base.parent().ok_or("Invalid Host configuration location")?,
            admission,
        )?;
        config.private_sources = std::mem::take(&mut prepared.sources.private_sources);
        config
            .private_sources
            .append(&mut observers.sources.private_sources);
        config.private_sources.push(private_config);
        config.runtime_plugins = prepared.installations;
        config.runtime_plugin_roots = prepared.roots;
        config.runtime_observer_profiles = observers.installations;
        config.runtime_observer_roots = observers.roots;
        config.plugin_sources = prepared.sources;
        config.observer_sources = observers.sources;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), String> {
        crate::observer_profiles::validate_profiles(&self.observer_profiles, &self.plugins)?;
        if let Some(device) = &self.device_provider {
            device.validate()?;
        }
        if let Some(storage) = &self.storage {
            storage.validate()?;
        }
        if let Some(audit) = &self.diagnostic_audit {
            audit.validate()?;
        }
        if self
            .network_request_body_reader
            .as_ref()
            .is_some_and(|reader| {
                reader.capability_name != "host.network.request-body.read"
                    || !(1..=1024 * 1024).contains(&reader.max_read_bytes)
                    || !(1..=1024).contains(&reader.max_reads)
            })
        {
            return Err("Invalid network request body reader capability selection".into());
        }
        if self
            .diagnostic_source_reader
            .as_ref()
            .is_some_and(|reader| {
                reader.capability_name != "host.diagnostics.source.read"
                    || !(1..=1024 * 1024).contains(&reader.max_read_bytes)
                    || !(1..=1024).contains(&reader.max_reads)
            })
        {
            return Err("Invalid diagnostic source reader capability selection".into());
        }
        if self
            .process_profile_id
            .as_ref()
            .is_some_and(|id| !valid_process_profile_id(id))
            || (self.process_profile.is_some() && self.process_profile_id.is_none())
            || (self.process_backend_installation.is_some() && self.process_profile.is_none())
        {
            return Err("Invalid Process profile selection".into());
        }
        if self.network_trust_roots.len() > 8
            || self
                .network_trust_roots
                .iter()
                .any(|root| root.len() > 65536)
        {
            return Err("Network trust roots exceed Host bounds".into());
        }
        if self.schema_version != 1
            || !self.sandbox_policy.is_object()
            || self.filesystem_roots.len() > 64
            || self.runtime_plugins.len() > 128
            || self.runtime_plugin_roots.len() > 128
            || self.runtime_observer_profiles.len() > 4
            || self.runtime_observer_roots.len() > 4
            || self.plugins.len() > 128
            || self.private_sources.len() > crate::SourceAdmission::LIMIT
        {
            return Err("Unsupported Host configuration".into());
        }
        let mut roots = std::collections::HashSet::new();
        for root in &self.filesystem_roots {
            if root.root_id.is_empty()
                || root.root_id.len() > 128
                || !root
                    .root_id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
                || !roots.insert(&root.root_id)
                || !root.host_path.is_absolute()
            {
                return Err("Invalid or duplicate filesystem installation".into());
            }
        }
        Ok(())
    }

    pub fn prepare_diagnostic_audit(&mut self) -> Result<(), String> {
        if let Some(config) = &self.diagnostic_audit {
            self.diagnostic_audit_writer = Some(crate::NativeDiagnosticAudit::open(
                config,
                &self.plugin_sources.admission,
            )?);
        }
        Ok(())
    }

    pub fn install_process_profile(&mut self, manifest_path: &Path) -> Result<(), String> {
        let selected = self
            .process_profile_id
            .as_ref()
            .ok_or("Process profile ID is required")?;
        if self.process_profile.is_some() {
            return Err("Process profile is already installed".into());
        }
        let (bytes, private) = read_owner_manifest(
            manifest_path,
            &self.plugin_sources.admission,
            MAX_LAUNCH_BYTES,
        )?;
        let manifest: ProcessProfileManifest = serde_json::from_slice(&bytes)
            .map_err(|_| "Process profile manifest has invalid syntax or fields")?;
        if manifest.schema_version != 1
            || manifest.profiles.len() > 64
            || manifest
                .profiles
                .keys()
                .any(|id| !valid_process_profile_id(id))
        {
            return Err("Invalid Process profile manifest".into());
        }
        let profile = manifest
            .profiles
            .get(selected)
            .ok_or("Selected Process profile is unavailable")?;
        if !profile.is_object() {
            return Err("Selected Process profile is invalid".into());
        }
        self.process_profile = Some(profile.clone());
        self.private_sources.push(private);
        self.validate()
    }

    pub fn enable_experimental_v86_process(&mut self) -> Result<(), String> {
        let installation = self
            .process_backend_installation
            .as_mut()
            .and_then(Value::as_object_mut)
            .ok_or("Experimental v86 requires an installed Process Backend")?;
        if installation.get("backendId").and_then(Value::as_str) != Some("experimental.v86-v1") {
            return Err("Experimental v86 requires the selected v86 Backend".into());
        }
        installation.insert("experimentalEnable".into(), Value::Bool(true));
        self.validate()
    }

    pub fn install_process_backend(&mut self, manifest_path: &Path) -> Result<(), String> {
        if self.process_backend_installation.is_some() {
            return Err("Process Backend is already installed".into());
        }
        let backend_id = self
            .process_profile
            .as_ref()
            .and_then(|profile| profile.pointer("/backend/backendId"))
            .and_then(Value::as_str)
            .ok_or("Selected Process profile has no Backend")?;
        if backend_id != "experimental.v86-v1" {
            return Err("Selected Process Backend does not require a separate installation".into());
        }
        let (bytes, private) =
            read_owner_manifest(manifest_path, &self.plugin_sources.admission, 256 * 1024)?;
        let manifest: ProcessBackendManifest = serde_json::from_slice(&bytes)
            .map_err(|_| "Process Backend manifest has invalid syntax or fields")?;
        if manifest.schema_version != 1
            || manifest.backends.len() > 16
            || manifest
                .backends
                .keys()
                .any(|id| !valid_process_profile_id(id))
        {
            return Err("Invalid Process Backend manifest".into());
        }
        let installation = manifest
            .backends
            .get(backend_id)
            .ok_or("Selected Process Backend is unavailable")?;
        if installation.implementation != "builtin.v86-v1"
            || !installation.artifact_root.is_absolute()
            || installation.artifact_root.to_string_lossy().len() > 4096
        {
            return Err("Invalid Process Backend installation".into());
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let root = options
            .open(&installation.artifact_root)
            .map_err(|_| "Process Backend asset root is unavailable")?;
        let metadata = root
            .metadata()
            .map_err(|_| "Process Backend asset root is unavailable")?;
        if !metadata.is_dir()
            || installation
                .artifact_root
                .canonicalize()
                .map_err(|_| "Invalid Process Backend asset root")?
                != installation.artifact_root
        {
            return Err("Invalid Process Backend asset root".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
                return Err("Process Backend asset root must be owner controlled".into());
            }
        }
        self.process_backend_installation = Some(json!({
            "artifactRoot": installation.artifact_root,
            "backendId": backend_id,
            "implementation": installation.implementation
        }));
        self.private_sources.push(private);
        self.validate()
    }

    fn restore_plugin_sources(&mut self) -> Result<(), String> {
        if self.observer_profiles.len() != self.runtime_observer_profiles.len()
            || self.runtime_observer_profiles.len() != self.runtime_observer_roots.len()
        {
            return Err("Observer private launch resources are inconsistent".into());
        }
        for ((selected, prepared), root) in self
            .observer_profiles
            .iter()
            .zip(&self.runtime_observer_profiles)
            .zip(&self.runtime_observer_roots)
        {
            let instance = format!("observer.{}", selected.id);
            if selected.id != prepared.id
                || prepared.module.instance_id != instance
                || self
                    .runtime_plugins
                    .iter()
                    .any(|plugin| plugin.instance_id == instance)
                || root.instance_id != instance
                || prepared.module.root_url != format!("holo-plugins:///{instance}/")
                || !prepared
                    .module
                    .entry_url
                    .starts_with(&prepared.module.root_url)
                || prepared.module.config != selected.config
                || prepared.module.export_name != selected.export_name
                || prepared.module.integrity != selected.integrity
                || prepared.registration != selected.registration
                || prepared.sink.path != selected.sink.path
                || prepared.sink.max_bytes != selected.sink.max_bytes
            {
                return Err("Observer private launch resources are inconsistent".into());
            }
        }
        let admission = crate::SourceAdmission::default();
        admission.restore(&self.private_sources)?;
        self.plugin_sources.admission = admission.clone();
        self.plugin_sources = restore_native_sources(
            &self.runtime_plugins,
            &self.runtime_plugin_roots,
            admission.clone(),
            false,
        )?;
        self.observer_sources = restore_native_sources(
            &self
                .runtime_observer_profiles
                .iter()
                .map(|profile| profile.module.clone())
                .collect::<Vec<_>>(),
            &self.runtime_observer_roots,
            admission,
            true,
        )?;
        Ok(())
    }
}

fn restore_native_sources(
    modules: &[RuntimePluginInstallation],
    roots: &[RuntimePluginSourceRoot],
    admission: crate::SourceAdmission,
    observer_limits: bool,
) -> Result<NativePluginSources, String> {
    if modules.len() != roots.len() {
        return Err("Native plugin private launch resources are inconsistent".into());
    }
    let ids = roots
        .iter()
        .map(|root| root.instance_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    if modules
        .iter()
        .any(|module| !ids.contains(module.instance_id.as_str()))
    {
        return Err("Native plugin private launch resources are inconsistent".into());
    }
    for module in modules {
        let root = roots
            .iter()
            .find(|root| root.instance_id == module.instance_id)
            .ok_or("Native plugin private launch resources are inconsistent")?;
        if let Some(graph) = &module.resource_graph {
            let binding = root
                .resource_root
                .as_ref()
                .ok_or("Native plugin private resource graph is unavailable")?;
            if graph.schema_version != 2
                || graph.root_url != module.root_url
                || binding.root_url != graph.root_url
                || graph.required == binding.reads.is_empty()
                || !graph.entry_url.starts_with(&graph.root_url)
            {
                return Err("Native plugin private resource graph is inconsistent".into());
            }
        } else if root
            .resource_root
            .as_ref()
            .is_some_and(|binding| !binding.reads.is_empty())
        {
            return Err("Native plugin private resource graph is inconsistent".into());
        }
    }
    let mut sources = NativePluginSources::from_roots(roots)?;
    sources.admission = admission;
    sources.install_resource_roots(roots)?;
    if observer_limits {
        sources.apply_observer_limits();
    }
    sources.restore_package_names(roots)?;
    Ok(sources)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProcessProfileManifest {
    schema_version: u32,
    profiles: BTreeMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProcessBackendManifest {
    schema_version: u32,
    backends: BTreeMap<String, ProcessBackendInstallation>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProcessBackendInstallation {
    artifact_root: PathBuf,
    implementation: String,
}

fn read_owner_manifest(
    manifest_path: &Path,
    admission: &crate::SourceAdmission,
    maximum: u64,
) -> Result<(Vec<u8>, crate::PrivateSource), String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let file = options
        .open(manifest_path)
        .map_err(|_| "Process manifest is unavailable")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Process manifest is unavailable")?;
    if !metadata.is_file() || metadata.len() > maximum {
        return Err("Process manifest must be a bounded regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err("Process manifest must be owner-only".into());
        }
    }
    let path = manifest_path
        .canonicalize()
        .map_err(|_| "Process manifest is unavailable")?;
    let private = admission.capture(&path, &file)?;
    let mut bytes = Vec::new();
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read Process manifest")?;
    if bytes.len() as u64 > maximum {
        return Err("Process manifest exceeds byte limit".into());
    }
    Ok((bytes, private))
}

fn valid_process_profile_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    id.len() <= 128
        && bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeLaunch {
    pub schema_version: u32,
    pub generation: u64,
    pub entry: PathBuf,
    /// Version 2 only: owner-selected source workspace, never a Guest option.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<PathBuf>,
    pub argv: Vec<String>,
    pub timeout: Option<u64>,
    pub test_mode: bool,
    pub host_config: Option<HostConfiguration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_config: Option<PathBuf>,
    /// Service-owned Host configuration, read through normal source admission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_plugin_config: Option<PathBuf>,
    /// Service-owned selected Process manifest. Read after any Host config reload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_profiles_manifest: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_plugin_revision: Option<u64>,
    /// Owner-private Unix Inspector endpoint, never copied into Guest argv.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inspector_socket: Option<PathBuf>,
    /// Hold Guest entry until the owner-private Inspector session releases it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub inspector_wait_for_debugger: bool,
    /// Optional exact logical source identities for a Service-owned snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module_allowlist: Option<Vec<String>>,
    /// Version 3 only: flat logical-to-staged module identities.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module_aliases: Option<Vec<crate::ModuleAlias>>,
    /// Version 4 only: exact physical staged package metadata identities.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub module_metadata_only: Vec<String>,
}

impl RuntimeLaunch {
    pub fn validate(&self) -> Result<(), String> {
        let valid_workspace = match (self.schema_version, self.workspace_root.as_deref()) {
            (1, None) if self.module_aliases.is_none() => true,
            (2, Some(root)) if self.module_aliases.is_none() => {
                root.is_absolute()
                    && root
                        .to_str()
                        .is_some_and(|value| value.len() <= 4096 && !value.contains('\0'))
            }
            (3, Some(root))
                if self.module_allowlist.is_some()
                    && self
                        .module_aliases
                        .as_ref()
                        .is_some_and(|aliases| !aliases.is_empty()) =>
            {
                root.is_absolute()
                    && root
                        .to_str()
                        .is_some_and(|value| value.len() <= 4096 && !value.contains('\0'))
            }
            (4, Some(root))
                if self.module_allowlist.is_some() && !self.module_metadata_only.is_empty() =>
            {
                root.is_absolute()
                    && root
                        .to_str()
                        .is_some_and(|value| value.len() <= 4096 && !value.contains('\0'))
            }
            _ => false,
        };
        if !valid_workspace
            || self.generation != 1
            || self.module_allowlist.as_ref().is_some_and(|urls| {
                urls.is_empty()
                    || urls.len() > if self.schema_version >= 3 { 1024 } else { 512 }
                    || urls.iter().any(|url| url.len() > 4096)
                    || urls.iter().map(String::len).sum::<usize>() > 512 * 1024
            })
            || self.module_aliases.as_ref().is_some_and(|aliases| {
                aliases.len() > 512
                    || aliases
                        .iter()
                        .any(|alias| alias.url.len() > 4096 || alias.canonical_url.len() > 4096)
                    || aliases
                        .iter()
                        .map(|alias| alias.url.len() + alias.canonical_url.len())
                        .sum::<usize>()
                        > 256 * 1024
            })
            || (self.schema_version != 4 && !self.module_metadata_only.is_empty())
            || self.module_metadata_only.len() > crate::MAX_MODULES
            || self
                .module_metadata_only
                .iter()
                .collect::<HashSet<_>>()
                .len()
                != self.module_metadata_only.len()
            || self
                .module_metadata_only
                .iter()
                .map(String::len)
                .sum::<usize>()
                > 256 * 1024
            || self.module_metadata_only.iter().any(|value| {
                value.len() > 4096
                    || !value.starts_with("app://workspace/")
                    || !value.ends_with("/package.json")
                    || self
                        .module_allowlist
                        .as_ref()
                        .is_none_or(|urls| !urls.contains(value))
                    || url::Url::parse(value).map_or(true, |url| {
                        url.as_str() != value || url.query().is_some() || url.fragment().is_some()
                    })
            })
            || !self.entry.is_absolute()
            || self.watch_config.as_ref().is_some_and(|path| {
                !path.is_absolute() || self.host_config.is_none() || self.test_mode
            })
            || self.service_plugin_config.as_ref().is_some_and(|path| {
                !path.is_absolute()
                    || self.host_config.is_none()
                    || (!self.test_mode && self.watch_config.as_ref() != Some(path))
            })
            || self.process_profiles_manifest.as_ref().is_some_and(|path| {
                !path.is_absolute()
                    || path
                        .to_str()
                        .is_none_or(|text| text.len() > 4096 || text.contains('\0'))
                    || self.host_config.is_none()
            })
            || (self.service_plugin_config.is_some() != self.service_plugin_revision.is_some())
            || self
                .service_plugin_revision
                .is_some_and(|revision| revision > 9_007_199_254_740_991)
            || self
                .inspector_socket
                .as_ref()
                .is_some_and(|path| !path.is_absolute() || self.host_config.is_none())
            || (self.inspector_wait_for_debugger && self.inspector_socket.is_none())
            || self.argv.len() > 256
            || self
                .argv
                .iter()
                .any(|arg| arg.len() > 65536 || arg.contains('\0'))
            || self.argv.iter().map(String::len).sum::<usize>() > 256 * 1024
            || self
                .timeout
                .is_some_and(|value| value == 0 || value > 86_400_000)
        {
            return Err("Invalid private Runtime launch".into());
        }
        if let Some(config) = &self.host_config {
            config.validate()?;
            if config.process_profile_id.is_some() != config.process_profile.is_some() {
                return Err("Process profile selection is not installed".into());
            }
            let v86 = config.process_profile.as_ref().is_some_and(|profile| {
                profile
                    .pointer("/backend/backendId")
                    .and_then(Value::as_str)
                    == Some("experimental.v86-v1")
            });
            if v86 != config.process_backend_installation.is_some() {
                return Err("Process Backend installation is incomplete".into());
            }
            if let Some(installation) = &config.process_backend_installation {
                let fields = installation
                    .as_object()
                    .ok_or("Invalid private Process Backend installation")?;
                if fields.keys().any(|key| {
                    !matches!(
                        key.as_str(),
                        "artifactRoot" | "backendId" | "implementation" | "experimentalEnable"
                    )
                }) || fields.get("backendId").and_then(Value::as_str)
                    != Some("experimental.v86-v1")
                    || fields.get("implementation").and_then(Value::as_str)
                        != Some("builtin.v86-v1")
                    || fields.get("artifactRoot").and_then(Value::as_str).is_none()
                    || fields
                        .get("experimentalEnable")
                        .is_some_and(|value| !value.is_boolean())
                {
                    return Err("Invalid private Process Backend installation".into());
                }
            }
        }
        Ok(())
    }
    pub fn read(reader: impl BufRead) -> Result<Self, String> {
        let mut line = String::new();
        reader
            .take(MAX_LAUNCH_BYTES + 1)
            .read_line(&mut line)
            .map_err(|_| "Cannot read private launch")?;
        if line.len() as u64 > MAX_LAUNCH_BYTES || !line.ends_with('\n') {
            return Err("Private launch is oversized or incomplete".into());
        }
        let mut launch: Self =
            serde_json::from_str(&line).map_err(|_| "Invalid private launch schema")?;
        if let Some(path) = &launch.service_plugin_config {
            let mut config = HostConfiguration::read(path)?;
            config.plugin_graph_revision = launch.service_plugin_revision;
            launch.host_config = Some(config);
        } else if let Some(config) = launch.host_config.as_mut() {
            config.restore_plugin_sources()?;
        }
        if let Some(path) = &launch.process_profiles_manifest {
            let config = launch
                .host_config
                .as_mut()
                .ok_or("Process profile requires Host configuration")?;
            if config.process_profile.is_some() {
                return Err("Process profile is already installed".into());
            }
            config.install_process_profile(path)?;
        }
        launch.validate()?;
        Ok(launch)
    }
    pub fn encode(&self) -> Result<String, String> {
        self.validate()?;
        let text = serde_json::to_string(self).map_err(|_| "Cannot encode Runtime launch")?;
        if text.len() as u64 >= MAX_LAUNCH_BYTES {
            return Err("Runtime launch exceeds byte limit".into());
        }
        Ok(text)
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}
