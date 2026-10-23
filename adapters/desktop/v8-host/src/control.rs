//! Native Control facade. Host execution and Guest delivery have separate owners.
mod calls;
mod events;
mod gates;
mod guest;
mod guest_sync;
mod module_gate;
mod monitor;
mod native;
mod protocol;
mod pump;
mod remote;
mod state;
mod transport;
#[cfg(feature = "v86-backend")]
mod v86;
mod value;
mod worker;
mod worker_loop;

pub(crate) use calls::invoke_promise as invoke_host_promise;
pub use events::{subscribe, unsubscribe};
pub use guest::{invoke_async, invoke_promise};
pub use guest_sync::{decide_engine_code, invoke};
pub(crate) use module_gate::ModuleGateDecision;
pub(crate) use monitor::HostMonitor;
pub use pump::pump;
pub use remote::RemoteControl;
pub use state::ControlState;
