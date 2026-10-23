use super::{
    native,
    state::ControlState,
    transport::{Shared, WorkerChannels},
};
use crate::state::{HostState, SharedState};
use holonomy_desktop_host::HostConfiguration;
use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

// This startup barrier completes Host-only source planning and role labeling
// before RemoteControl::new returns and Guest module planning can begin.
fn prepare_host_sources(
    scope: &mut v8::PinScope,
    shared: &Shared,
    method: &str,
    deadline: Instant,
) -> Option<()> {
    let promise = super::calls::invoke_promise(scope, method, &[])?;
    let promise = v8::Local::new(scope, promise);
    while promise.state() == v8::PromiseState::Pending {
        if shared.stopped() || scope.is_execution_terminating() || Instant::now() >= deadline {
            return None;
        }
        while v8::Platform::pump_message_loop(&v8::V8::get_current_platform(), scope, false) {}
        scope.perform_microtask_checkpoint();
        crate::rejection::check(scope)?;
        if promise.state() == v8::PromiseState::Pending {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    (promise.state() == v8::PromiseState::Fulfilled).then_some(())
}

pub(super) fn run(
    configuration: HostConfiguration,
    watch: Option<PathBuf>,
    service_plugin_ack: bool,
    inspector_installed: bool,
    epoch: Instant,
    shared: Arc<Shared>,
    channels: WorkerChannels,
) {
    crate::driver::initialize_engine();
    let mut isolate =
        v8::Isolate::new(v8::CreateParams::default().heap_limits(0, 256 * 1024 * 1024));
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_host_import_module_dynamically_callback(crate::modules::import_dynamic);
    isolate.set_host_initialize_import_meta_object_callback(crate::modules::import_meta);
    isolate.set_promise_reject_callback(crate::rejection::callback);
    crate::engine_gate::install(&mut isolate);
    if let Ok(mut handle) = shared.monitor.handle.lock() {
        *handle = Some(isolate.thread_safe_handle());
    }
    let mut owned = HostState::new(None, String::new(), epoch);
    let control = ControlState::new_with_inspector(
        configuration,
        watch,
        service_plugin_ack,
        inspector_installed,
    );
    #[cfg(feature = "v86-backend")]
    let control = {
        let mut control = control;
        control.vm.set_failure_monitor(Arc::clone(&shared.monitor));
        control
    };
    owned.control = Some(control);
    let state: SharedState = Rc::new(RefCell::new(owned));
    isolate.set_slot(state.clone());
    let outcome = {
        v8::scope!(let scope, &mut isolate);
        let context = v8::Context::new(scope, Default::default());
        let scope = &mut v8::ContextScope::new(scope, context);
        v8::tc_scope!(let tc, scope);
        let preflight_deadline = Instant::now() + Duration::from_secs(25);
        if shared.stopped()
            || native::initialize(tc).is_none()
            || prepare_host_sources(tc, &shared, "prepareObserverProfiles", preflight_deadline)
                .is_none()
            || prepare_host_sources(tc, &shared, "prepareHostPlugins", preflight_deadline).is_none()
        {
            let _ = channels
                .ready
                .try_send(Err(super::protocol::ControlFailure::ExecutionFailed));
            None
        } else {
            let limits = super::calls::invoke_host(tc, "gateConfiguration", &[])
                .and_then(|value| serde_json::from_str::<super::transport::GateLimits>(&value).ok())
                .filter(|limits| limits.valid());
            if let Some(limits) = limits {
                let _ = channels.ready.try_send(Ok(limits));
                super::worker_loop::run(tc, &state, &shared, &channels)
            } else {
                let _ = channels
                    .ready
                    .try_send(Err(super::protocol::ControlFailure::ExecutionFailed));
                None
            }
        }
    };
    if outcome.is_none() && !shared.stopped() {
        shared.monitor.failed.store(true, Ordering::Release);
    }
    shared.active.store(false, Ordering::Release);
    shared.busy.store(false, Ordering::Release);
    if let Ok(mut handle) = shared.monitor.handle.lock() {
        *handle = None;
    }
    isolate.remove_slot::<SharedState>();
    drop(state);
    // All Host Globals/native resources are dropped before their isolate.
}
