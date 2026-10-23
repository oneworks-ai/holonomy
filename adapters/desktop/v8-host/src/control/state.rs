use super::protocol::CallLedger;
use holonomy_desktop_host::{
    HostConfiguration, NativeFilesystem, NativeObserverSink, NativePluginSources,
    RuntimeObserverProfileInstallation,
};
use std::{collections::HashMap, path::PathBuf};

/// Constructed and destroyed only on the Host worker's isolate thread.
pub struct ControlState {
    pub(super) device: holonomy_desktop_host::device::NativeDevice,
    #[cfg(target_os = "macos")]
    pub(super) process_io: Option<holonomy_desktop_host::darwin_process::ProcessIoClient>,
    #[cfg(feature = "v86-backend")]
    pub(super) vm: super::v86::HostVm,
    pub(crate) network: Option<crate::network_io::NetworkIo>,
    #[cfg(feature = "v86-backend")]
    pub(crate) process_network: Option<crate::process_network_io::ProcessNetworkIo>,
    pub(crate) storage: Option<crate::storage_io::StorageIo>,
    pub(super) configuration: String,
    pub(super) filesystem: NativeFilesystem,
    pub(super) diagnostic_audit: Option<holonomy_desktop_host::NativeDiagnosticAudit>,
    pub(crate) plugins: NativePluginSources,
    pub(crate) observer_profiles: HashMap<String, RuntimeObserverProfileInstallation>,
    pub(crate) observer_sources: NativePluginSources,
    pub(crate) observer_sinks: HashMap<String, NativeObserverSink>,
    pub(crate) observer_executor: crate::observer_executor::ObserverExecutor,
    pub(crate) watch: Option<crate::plugin_watch::PluginWatchState>,
    pub(crate) context: Option<v8::Global<v8::Context>>,
    pub(super) api: Option<v8::Global<v8::Object>>,
    pub(super) next_timer: u32,
    pub(super) timers: HashMap<u32, (f64, v8::Global<v8::Function>, bool)>,
    pub(super) pending: CallLedger<PendingHost>,
}

pub(crate) struct GuestDelivery {
    pub(crate) port: crate::port_bridge::PortBridge,
    pub(super) subscriptions: HashMap<String, Subscription>,
    pub(super) events_pending: bool,
    pub(super) pending: CallLedger<PendingGuest>,
}
impl Default for GuestDelivery {
    fn default() -> Self {
        Self {
            port: crate::port_bridge::PortBridge::default(),
            subscriptions: HashMap::new(),
            events_pending: false,
            pending: CallLedger::new(1),
        }
    }
}
pub(super) struct Subscription {
    pub callback: v8::Global<v8::Function>,
    pub context: v8::Global<v8::Context>,
}
pub(super) struct PendingGuest {
    pub resolver: v8::Global<v8::PromiseResolver>,
    pub context: v8::Global<v8::Context>,
}
pub(super) struct PendingHost {
    pub promise: Option<v8::Global<v8::Promise>>,
    pub allow_undefined: bool,
}

impl ControlState {
    #[cfg(all(test, feature = "v86-backend"))]
    pub fn new(configuration: HostConfiguration, watch_config: Option<PathBuf>) -> Self {
        Self::new_with_inspector(configuration, watch_config, false, false)
    }
    pub fn new_with_inspector(
        mut configuration: HostConfiguration,
        watch_config: Option<PathBuf>,
        service_plugin_ack: bool,
        inspector_installed: bool,
    ) -> Self {
        let device_selected = configuration.device_provider.is_some();
        let mut configuration_value =
            serde_json::to_value(&configuration).expect("Serializable Host config");
        configuration_value["inspectorInstalled"] = serde_json::json!(inspector_installed);
        configuration_value["diagnosticAuditReady"] =
            serde_json::json!(configuration.diagnostic_audit_writer.is_some());
        // The Host controller needs only the profile plan metadata. Sink path
        // and live writer handles remain entirely in Rust.
        if let Some(profiles) = configuration_value["runtimeObserverProfiles"].as_array_mut() {
            for profile in profiles {
                if let Some(object) = profile.as_object_mut() {
                    object.remove("sink");
                }
            }
        }
        if let Some(configuration) = configuration_value.as_object_mut() {
            configuration.remove("observerProfiles");
            configuration.remove("runtimeObserverRoots");
            configuration.remove("runtimePluginRoots");
        }
        let configuration_json = configuration_value.to_string();
        let watch = watch_config.map(|path| {
            crate::plugin_watch::PluginWatchState::new(path, &configuration, service_plugin_ack)
        });
        let plugins = std::mem::take(&mut configuration.plugin_sources);
        let observer_profiles = std::mem::take(&mut configuration.runtime_observer_profiles)
            .into_iter()
            .map(|profile| (profile.id.clone(), profile))
            .collect();
        let observer_sources = std::mem::take(&mut configuration.observer_sources);
        let observer_sinks = std::mem::take(&mut configuration.observer_sinks);
        let storage = configuration
            .storage
            .take()
            .map(crate::storage_io::StorageIo::new);
        Self {
            device: holonomy_desktop_host::device::NativeDevice::new(device_selected),
            #[cfg(target_os = "macos")]
            process_io: None,
            #[cfg(feature = "v86-backend")]
            vm: super::v86::HostVm::new(),
            network: None,
            #[cfg(feature = "v86-backend")]
            process_network: None,
            storage,
            configuration: configuration_json,
            filesystem: NativeFilesystem::new(configuration.filesystem_roots),
            diagnostic_audit: configuration.diagnostic_audit_writer.take(),
            plugins,
            observer_profiles,
            observer_sources,
            observer_sinks,
            observer_executor: crate::observer_executor::ObserverExecutor::new(),
            watch,
            context: None,
            api: None,
            next_timer: 0,
            timers: HashMap::new(),
            pending: CallLedger::new(1),
        }
    }
    pub fn active(&self) -> bool {
        self.watch
            .as_ref()
            .is_some_and(crate::plugin_watch::PluginWatchState::active)
            || {
                #[cfg(feature = "v86-backend")]
                {
                    self.vm.active()
                }
                #[cfg(not(feature = "v86-backend"))]
                {
                    false
                }
            }
            || self.has_work()
    }
    pub fn idle_delay(&self) -> std::time::Duration {
        std::time::Duration::from_millis(if self.has_work() { 1 } else { 20 })
    }
    pub(super) fn has_work(&self) -> bool {
        self.network
            .as_ref()
            .is_some_and(crate::network_io::NetworkIo::active)
            || {
                #[cfg(feature = "v86-backend")]
                {
                    self.process_network
                        .as_ref()
                        .is_some_and(crate::process_network_io::ProcessNetworkIo::active)
                }
                #[cfg(not(feature = "v86-backend"))]
                {
                    false
                }
            }
            || self
                .storage
                .as_ref()
                .is_some_and(crate::storage_io::StorageIo::active)
            || {
                #[cfg(feature = "v86-backend")]
                {
                    self.vm.busy()
                }
                #[cfg(not(feature = "v86-backend"))]
                {
                    false
                }
            }
            || !self.pending.is_empty()
            || self.timers.values().any(|entry| entry.2)
            || self.filesystem.has_referenced_watchers()
    }
}
impl Drop for ControlState {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        self.process_io.take();
        #[cfg(feature = "v86-backend")]
        self.vm.close_all();
        #[cfg(feature = "v86-backend")]
        self.process_network.take();
        self.observer_executor.close();
        for sink in self.observer_sinks.values() {
            sink.close();
        }
        self.pending.close();
    }
}
impl Drop for GuestDelivery {
    fn drop(&mut self) {
        self.pending.close();
    }
}

#[cfg(test)]
mod observer_profile_tests {
    use super::*;

    #[test]
    fn prepared_profile_moves_to_state_without_serializing_sink_or_owner_source() {
        let config: HostConfiguration = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "sandboxPolicy": {"schemaVersion": 2},
            "observerProfiles": [{
                "id": "monitor", "use": "./monitor.mjs", "registration": {"events": ["runtime.terminated"]},
                "sink": {"path": "/private/owner-source.jsonl", "maxBytes": 1024}
            }],
            "runtimeObserverProfiles": [{
                "id": "monitor", "registration": {"events": ["runtime.terminated"]},
                "module": {
                    "config": {"private": true}, "configSchema": null,
                    "entryUrl": "holo-plugins:///observer.monitor/index.mjs",
                    "exportName": "default", "instanceId": "observer.monitor", "integrity": null,
                    "rootUrl": "holo-plugins:///observer.monitor/"
                },
                "sink": {"path": "/private/prepared-sink.jsonl", "maxBytes": 1024}
            }],
            "runtimeObserverRoots": []
        }))
        .unwrap();
        let state = ControlState::new_with_inspector(config, None, false, false);
        let view: serde_json::Value = serde_json::from_str(&state.configuration).unwrap();
        assert!(view.get("observerProfiles").is_none());
        assert!(view.get("runtimeObserverRoots").is_none());
        assert!(view["runtimeObserverProfiles"][0].get("sink").is_none());
        assert_eq!(
            view["runtimeObserverProfiles"][0]["module"]["config"]["private"],
            true
        );
        assert!(state.observer_profiles.contains_key("monitor"));
        assert!(!state.has_work());
    }
}

#[cfg(all(test, feature = "v86-backend"))]
mod vm_tests {
    use super::*;
    use sha2::Digest;

    #[test]
    fn control_state_rejects_absent_assets_before_vm_admission_and_closes_idle() {
        let config: HostConfiguration = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "sandboxPolicy": {"schemaVersion": 2}
        }))
        .unwrap();
        let mut state = ControlState::new(config, None);
        let result: serde_json::Value = serde_json::from_str(
            &state.vm.command(
                &serde_json::json!({
                    "schemaVersion": 1,
                    "kind": "install",
                    "root": "/definitely-absent-holonomy-v86-assets",
                "bios": {"size": 1, "sha256": "0".repeat(64)},
                "kernel": {"size": 1, "sha256": "0".repeat(64)},
                "initrd": {"size": 1, "sha256": "0".repeat(64)},
                "wasmSha256": format!("{:x}", sha2::Sha256::digest(crate::v86_probe::V86_WASM))
                })
                .to_string(),
            ),
        )
        .unwrap();
        assert_eq!(result["code"], "artifact");
        assert!(!state.active());
        assert!(!state.has_work());
        assert_eq!(state.idle_delay(), std::time::Duration::from_millis(20));
        state.vm.close_all();
        assert!(!state.active());
    }
}
