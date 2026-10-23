//! Standalone V8 embedder; shared JavaScript remains the public API owner.
mod callback_diagnostic;
mod commonjs;
mod control;
mod crypto;
mod driver;
mod engine_gate;
mod host;
mod inspector;
mod module_planner;
mod modules;
mod network_io;
mod observer;
mod observer_executor;
mod plugin_graph;
mod plugin_schema;
mod plugin_watch;
mod port_bridge;
#[cfg(feature = "v86-backend")]
mod process_network_io;
mod rejection;
mod state;
mod storage_io;
#[cfg(feature = "v86-backend")]
mod v86_probe;
#[cfg(feature = "v86-backend")]
mod v86_vm;
mod wasm;
pub use driver::{RunOptions, run};
#[doc(hidden)]
pub use observer_executor::observer_executor_helper_entry;
#[doc(hidden)]
pub use plugin_schema::helper_entry as plugin_validator_helper_entry;
pub const RUNTIME_ASSET_SHA256: &str = include_str!("../generated/runtime.sha256");
pub const CONTROL_ASSET_SHA256: &str = include_str!("../generated/control.sha256");
pub const PLUGIN_VALIDATOR_ASSET_SHA256: &str =
    include_str!("../generated/plugin-validator.sha256");
pub const MODULE_PLANNER_ASSET_SHA256: &str = include_str!("../generated/module-planner.sha256");
pub const V86_BACKEND_COMPILED: bool = cfg!(feature = "v86-backend");

pub fn engine_version() -> &'static str {
    v8::V8::get_version()
}

/// Diagnostic only: boots verified v86 artifacts without Node or Guest APIs.
/// A successful serial probe does not establish Process capability support.
#[doc(hidden)]
#[cfg(feature = "v86-backend")]
pub fn probe_v86_boot(
    root: &std::path::Path,
    digests: [String; 3],
    duration: std::time::Duration,
) -> Result<Vec<u8>, String> {
    use holonomy_desktop_host::v86::{ArtifactSpec, NativeVmPort, VerifiedArtifacts, VmStatus};
    let names = ["seabios.bin", "kernel.bin", "agent.cpio"];
    let specs = std::array::from_fn(|index| ArtifactSpec {
        name: names[index],
        sha256: digests[index].clone(),
        size: std::fs::metadata(root.join(names[index]))
            .map(|meta| meta.len())
            .unwrap_or(0),
    });
    let artifacts = VerifiedArtifacts::install(root, &specs)
        .map_err(|err| format!("artifact installation: {err:?}"))?;
    let mut port = NativeVmPort::new(v86_vm::V8VmEngine);
    port.open("probe", 1, 128 * 1024 * 1024, &artifacts)
        .map_err(|err| format!("VM open: {err:?}"))?;
    port.start("probe", 1)
        .map_err(|err| format!("VM start: {err:?}"))?;
    let deadline = std::time::Instant::now() + duration;
    let mut serial = Vec::new();
    while std::time::Instant::now() < deadline {
        let status = port
            .poll("probe", 1)
            .map_err(|err| format!("VM poll: {err:?}"))?;
        let bytes = port
            .drain_serial("probe", 1, 65536)
            .map_err(|err| format!("serial drain: {err:?}"))?;
        if serial.len() + bytes.len() > 1024 * 1024 {
            return Err("serial probe output exceeded limit".into());
        }
        serial.extend(bytes);
        if status == VmStatus::Failed {
            return Err("VM failed".into());
        }
        if status == VmStatus::Stopped {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    port.close("probe", 1)
        .map_err(|err| format!("VM close: {err:?}"))?;
    Ok(serial)
}
