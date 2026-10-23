//! Engine-independent desktop host configuration and resource admission.
pub const MAX_MODULE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_GRAPH_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_MODULES: usize = 512;

mod source;
pub use source::{
    ModuleAlias, PrivateSource, SourceAdmission, SourceReadPurpose, SourceResource, SourceStore,
};
mod source_snapshot;
pub use source_snapshot::serve_source_snapshot;
mod plugins;
pub use plugins::{
    HostPluginInstallation, NativePluginSources, PreparedNativePlugins, RuntimePluginInstallation,
    RuntimePluginSourceRoot, prepare_native_plugins,
};
mod launch;
pub use launch::{
    DeviceProviderInstallation, FilesystemRootInstallation, HostConfiguration, RuntimeLaunch,
};
pub mod device;
mod diagnostic_audit;
mod secure_metadata_file;
pub use diagnostic_audit::{DiagnosticAuditInstallation, NativeDiagnosticAudit};
mod observer_profiles;
pub use observer_profiles::{
    ObserverProfileInstallation, ObserverSinkInstallation, RuntimeObserverProfileInstallation,
};
mod observer_sink;
pub use observer_sink::{NativeObserverSink, ObserverOutputRecord, ObserverOutputStatus};
mod plugin_watch;
pub use plugin_watch::PluginConfigWatch;
mod filesystem;
pub use filesystem::NativeFilesystem;
mod network;
pub use network::NativeNetwork;
mod process_network;
pub use process_network::NativeProcessNetwork;
mod storage;
pub use storage::{NativeStorage, StorageInstallation};
pub mod crypto;
#[cfg(target_os = "macos")]
pub mod darwin_process;
pub mod v86;
