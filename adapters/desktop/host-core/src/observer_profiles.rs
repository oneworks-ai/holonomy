//! Owner-selected diagnostic modules. They reuse plugin source admission but
//! are never included in the ordinary Cordis plugin installation list.
use crate::{
    HostConfiguration, HostPluginInstallation, NativePluginSources, RuntimePluginInstallation,
    RuntimePluginSourceRoot, SourceAdmission,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ObserverProfileInstallation {
    pub id: String,
    #[serde(rename = "use")]
    pub source: String,
    #[serde(default = "default_export", rename = "export")]
    pub export_name: String,
    #[serde(default = "empty_object")]
    pub config: Value,
    #[serde(default)]
    pub integrity: Option<String>,
    pub registration: Value,
    pub sink: ObserverSinkInstallation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RuntimeObserverProfileInstallation {
    pub id: String,
    pub registration: Value,
    pub module: RuntimePluginInstallation,
    pub sink: ObserverSinkInstallation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ObserverSinkInstallation {
    pub path: PathBuf,
    pub max_bytes: u64,
}

impl ObserverSinkInstallation {
    pub fn validate(&self) -> Result<(), String> {
        if self.path.as_os_str().is_empty()
            || self.path.as_os_str().len() > 4096
            || !(1024..=16 * 1024 * 1024).contains(&self.max_bytes)
        {
            return Err("Invalid observer sink installation".into());
        }
        Ok(())
    }
}

pub(crate) fn validate_profiles(
    profiles: &[ObserverProfileInstallation],
    plugins: &[HostPluginInstallation],
) -> Result<(), String> {
    if profiles.len() > 4 {
        return Err("Observer profile limit exceeded".into());
    }
    let mut ids = HashSet::new();
    for profile in profiles {
        let instance = format!("observer.{}", profile.id);
        if profile.id.is_empty()
            || profile.id.len() > 64
            || !crate::plugins::valid_id(&profile.id)
            || !ids.insert(profile.id.as_str())
            || plugins.iter().any(|plugin| plugin.id == instance)
            || profile.registration.as_object().is_none()
            || serde_json::to_vec(&profile.config).map_or(true, |bytes| bytes.len() > 64 * 1024)
        {
            return Err("Invalid or duplicate observer profile".into());
        }
        profile.sink.validate()?;
    }
    Ok(())
}

pub(crate) struct PreparedObserverProfiles {
    pub installations: Vec<RuntimeObserverProfileInstallation>,
    pub roots: Vec<RuntimePluginSourceRoot>,
    pub sources: NativePluginSources,
}

pub(crate) fn prepare_observer_profiles(
    profiles: &[ObserverProfileInstallation],
    allowed_roots: &[PathBuf],
    config_directory: &Path,
    admission: SourceAdmission,
) -> Result<PreparedObserverProfiles, String> {
    let modules = profiles
        .iter()
        .map(|profile| HostPluginInstallation {
            id: format!("observer.{}", profile.id),
            source: profile.source.clone(),
            export_name: profile.export_name.clone(),
            config: profile.config.clone(),
            integrity: profile.integrity.clone(),
            enabled: true,
            source_graph: None,
        })
        .collect::<Vec<_>>();
    let mut prepared = crate::plugins::prepare_native_plugins_with_admission(
        &modules,
        allowed_roots,
        config_directory,
        admission,
    )?;
    prepared.sources.apply_observer_limits();
    let installations = profiles
        .iter()
        .zip(prepared.installations)
        .map(|(profile, module)| RuntimeObserverProfileInstallation {
            id: profile.id.clone(),
            registration: profile.registration.clone(),
            module,
            sink: profile.sink.clone(),
        })
        .collect();
    Ok(PreparedObserverProfiles {
        installations,
        roots: prepared.roots,
        sources: prepared.sources,
    })
}

impl HostConfiguration {
    pub fn prepare_observer_sinks(&mut self) -> Result<(), String> {
        if self.runtime_observer_profiles.len() != self.observer_profiles.len() {
            return Err("Observer profiles are not prepared".into());
        }
        if !self.observer_sinks.is_empty() {
            return Err("Observer sinks are already prepared".into());
        }
        let mut sinks = std::collections::HashMap::new();
        let mut paths = HashSet::new();
        for profile in &self.runtime_observer_profiles {
            if !paths.insert(&profile.sink.path) {
                return Err("Observer sink path is duplicated".into());
            }
            let sink = crate::NativeObserverSink::open(
                &profile.id,
                &profile.sink,
                &self.plugin_sources.admission,
            )?;
            sinks.insert(profile.id.clone(), sink);
        }
        self.observer_sinks = sinks;
        Ok(())
    }
}

fn empty_object() -> Value {
    json!({})
}
fn default_export() -> String {
    "default".into()
}
