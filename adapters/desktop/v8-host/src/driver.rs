use crate::{
    host, modules,
    state::{HostState, SharedState, call, property},
};
use holonomy_desktop_host::SourceStore;
use serde_json::json;
use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    sync::{
        Arc, Once,
        atomic::{AtomicBool, Ordering},
        mpsc::Receiver,
    },
    time::{Duration, Instant},
};

const BOOTSTRAP: &str = include_str!("../generated/runtime.js");
static INITIALIZE: Once = Once::new();

pub struct RunOptions {
    pub entry: PathBuf,
    pub workspace_root: Option<PathBuf>,
    pub argv: Vec<String>,
    pub timeout: Option<Duration>,
    pub test_mode: bool,
    pub host_config: Option<holonomy_desktop_host::HostConfiguration>,
    pub watch_config: Option<PathBuf>,
    pub service_plugin_ack: bool,
    pub inspector_socket: Option<PathBuf>,
    pub inspector_wait_for_debugger: bool,
    pub module_allowlist: Option<Vec<String>>,
    pub module_aliases: Option<Vec<holonomy_desktop_host::ModuleAlias>>,
    pub module_metadata_only: Vec<String>,
}

pub(crate) fn initialize_engine() {
    INITIALIZE.call_once(|| {
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
    });
}

pub fn run(mut options: RunOptions, cancelled: Receiver<()>) -> Result<i32, String> {
    initialize_engine();
    if options.inspector_wait_for_debugger && options.inspector_socket.is_none() {
        return Err("Inspector wait requires an Inspector socket".into());
    }
    if let Some(configuration) = &mut options.host_config {
        configuration.prepare_diagnostic_audit()?;
        configuration.prepare_observer_sinks()?;
    }
    if let Some(configuration) = &options.host_config {
        let installations = configuration
            .runtime_plugins
            .iter()
            .chain(
                configuration
                    .runtime_observer_profiles
                    .iter()
                    .map(|profile| &profile.module),
            )
            .cloned()
            .collect::<Vec<_>>();
        crate::plugin_schema::validate(&installations)?;
    }
    let admission = options
        .host_config
        .as_ref()
        .map(|config| config.plugin_sources.admission.clone())
        .unwrap_or_default();
    let mut sources = match options.workspace_root.as_ref() {
        Some(root) => SourceStore::with_workspace_entry(root, &options.entry, admission)?,
        None => SourceStore::with_admission(&options.entry, admission)?,
    };
    if let Some(urls) = options.module_allowlist {
        sources.restrict_to_urls(urls)?;
    }
    if let Some(aliases) = options.module_aliases {
        sources.install_aliases(aliases)?;
    }
    if !options.module_metadata_only.is_empty() {
        sources.restrict_metadata_only(options.module_metadata_only)?;
    }
    let entry = sources.entry_url.clone();
    let configuration = json!({
        "entryUrl": entry, "argv": ([vec!["/runtime/holo".to_string(), entry.clone()], options.argv].concat()),
        "arch": if std::env::consts::ARCH == "aarch64" { "arm64" } else { std::env::consts::ARCH },
        "platform": if std::env::consts::OS == "macos" { "darwin" } else { std::env::consts::OS },
        "version": env!("CARGO_PKG_VERSION"), "v8": v8::V8::get_version(),
        "testMode": options.test_mode,
        "capabilityEnabled": options.host_config.is_some(),
    }).to_string();
    let mut isolate =
        v8::Isolate::new(v8::CreateParams::default().heap_limits(0, 256 * 1024 * 1024));
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_capture_stack_trace_for_uncaught_exceptions(true, 32);
    isolate.set_host_import_module_dynamically_callback(modules::import_dynamic);
    isolate.set_host_initialize_import_meta_object_callback(modules::import_meta);
    crate::engine_gate::install(&mut isolate);
    isolate.set_promise_reject_callback(crate::rejection::callback);
    let done = Arc::new(AtomicBool::new(false));
    let expired = Arc::new(AtomicBool::new(false));
    let handle = isolate.thread_safe_handle();
    let host_monitor = Arc::new(crate::control::HostMonitor::default());
    let watch_host = host_monitor.clone();
    let watch_done = done.clone();
    let watch_expired = expired.clone();
    let watchdog = std::thread::spawn(move || {
        let start = Instant::now();
        while !watch_done.load(Ordering::Acquire) {
            if watch_host.poll_failure() {
                watch_host.interrupt();
                handle.terminate_execution();
                break;
            }
            if options
                .timeout
                .is_some_and(|limit| start.elapsed() >= limit)
            {
                watch_expired.store(true, Ordering::Release);
                handle.terminate_execution();
                watch_host.interrupt();
                break;
            }
            if !matches!(
                cancelled.recv_timeout(Duration::from_millis(10)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ) {
                watch_expired.store(true, Ordering::Release);
                handle.terminate_execution();
                watch_host.interrupt();
                break;
            }
        }
    });
    let mut outcome = (|| {
        let epoch = Instant::now();
        let inspector_enabled = options.inspector_socket.is_some();
        let remote = options
            .host_config
            .map(|configuration| {
                crate::control::RemoteControl::new(
                    configuration,
                    options.watch_config,
                    options.service_plugin_ack,
                    inspector_enabled,
                    epoch,
                    expired.clone(),
                    host_monitor,
                )
            })
            .transpose()?;
        let mut owned = HostState::new(Some(sources), configuration, epoch);
        owned.remote = remote;
        let state: SharedState = Rc::new(RefCell::new(owned));
        isolate.set_slot(state.clone());
        if let Some(path) = options.inspector_socket.as_ref() {
            state.borrow_mut().inspector = Some(crate::inspector::InspectorRuntime::new(
                &mut isolate,
                Rc::downgrade(&state),
                path,
                expired.clone(),
                options.inspector_wait_for_debugger,
            )?);
        }
        v8::scope!(let scope, &mut isolate);
        let context = v8::Context::new(scope, Default::default());
        let scope = &mut v8::ContextScope::new(scope, context);
        context.set_allow_generation_from_strings(false);
        crate::engine_gate::mark_guest_context(scope, context);
        if let Some(inspector) = state.borrow().inspector.as_ref() {
            inspector.context_created(context);
        }
        v8::tc_scope!(let tc, scope);
        let mut result = execute(
            tc,
            &entry,
            &state,
            &expired,
            options.inspector_wait_for_debugger,
        );
        let exception = result
            .is_none()
            .then(|| tc.exception())
            .flatten()
            .map(|exception| v8::Global::new(tc, exception));
        if exception.is_some() {
            crate::observer::exception(tc, "runtime.execution_failed");
        }
        crate::observer::terminated(
            tc,
            if expired.load(Ordering::Acquire) {
                "stopped"
            } else if result.is_none()
                && (state.borrow().exit_code.is_none()
                    || options.test_mode && state.borrow().exit_code == Some(0))
            {
                "failed"
            } else {
                "completed"
            },
        );
        if exception.is_some() {
            tc.reset();
        }
        if close_control(tc, &state, &expired).is_none() && result.is_some() {
            result = None;
        }
        if let Some(inspector) = state.borrow().inspector.as_ref() {
            inspector.context_destroyed(context);
        }
        if let Some(exception) = exception {
            let exception = v8::Local::new(tc, exception);
            tc.throw_exception(exception);
        }
        if state
            .borrow()
            .remote
            .as_ref()
            .is_some_and(crate::control::RemoteControl::failed)
        {
            Err("Host worker execution failed".into())
        } else if options.test_mode && result.is_none() && state.borrow().exit_code == Some(0) {
            Err("Test execution terminated before completion".into())
        } else if let Some(code) = state.borrow().exit_code {
            Ok(code)
        } else if expired.load(Ordering::Acquire) {
            Err("Runtime cancelled or execution deadline exceeded".into())
        } else if result.is_none() {
            Err(tc
                .exception()
                .map(|exception| crate::callback_diagnostic::format_uncaught(tc, exception))
                .unwrap_or_else(|| "V8 execution failed".into()))
        } else {
            Ok(result.unwrap())
        }
    })();
    if outcome.is_err() && expired.load(Ordering::Acquire) {
        outcome = Err("Runtime cancelled or execution deadline exceeded".into());
    }
    if let Some(state) = isolate.get_slot::<SharedState>()
        && let Some(remote) = state.borrow_mut().remote.as_mut()
        && !remote.shutdown()
    {
        outcome = Err("Host worker shutdown failed; Runtime process must exit".into());
    }
    done.store(true, Ordering::Release);
    let _ = watchdog.join();
    isolate.remove_slot::<SharedState>();
    outcome
}

fn execute(
    scope: &mut v8::PinScope,
    entry: &str,
    state: &SharedState,
    expired: &AtomicBool,
    inspector_wait_for_debugger: bool,
) -> Option<i32> {
    host::install(scope)?;
    let source = v8::String::new(scope, BOOTSTRAP)?;
    let script = v8::Script::compile(scope, source, None)?;
    let ready = v8::Local::<v8::Promise>::try_from(script.run(scope)?).ok()?;
    drive_promise(scope, ready, state, expired, None)?;
    let controller = v8::Local::<v8::Object>::try_from(ready.result(scope)).ok()?;
    state.borrow_mut().controller = Some(v8::Global::new(scope, controller));
    let definitions = property(scope, controller, "moduleDefinitions")?.to_rust_string_lossy(scope);
    crate::module_planner::initialize(scope, &definitions)?;
    let planning = crate::module_planner::plan(scope, entry, "")?;
    let planning = v8::Local::new(scope, planning);
    // The private planner rejects only bounded public error-code strings. No
    // private Error/prototype, source content or native path crosses Contexts.
    drive_promise(
        scope,
        planning,
        state,
        expired,
        Some(PromiseFailure::Planner),
    )?;
    let plan = v8::Local::<v8::String>::try_from(planning.result(scope))
        .ok()?
        .to_rust_string_lossy(scope);
    if state.borrow().remote.is_some() {
        let initialized =
            crate::control::invoke_promise(scope, "initialize", std::slice::from_ref(&plan))?;
        let initialized = v8::Local::new(scope, initialized);
        drive_promise(
            scope,
            initialized,
            state,
            expired,
            Some(PromiseFailure::Host("Host Runtime initialization failed")),
        )?;
    }
    call(scope, controller, "initializeCapabilities", &[])?;
    if let Err(message) = modules::install_plan(scope, &plan) {
        let e = crate::state::error(scope, &message);
        scope.throw_exception(e);
        return None;
    }
    if inspector_wait_for_debugger {
        // The original Guest-thread pump holds entry after Host/plan admission.
        while state
            .borrow()
            .inspector
            .as_ref()
            .is_some_and(crate::inspector::InspectorRuntime::waiting_for_debugger)
        {
            pump(scope, state, expired)?;
            if state
                .borrow()
                .inspector
                .as_ref()
                .is_some_and(|inspector| !inspector.active())
            {
                let e = crate::state::error(scope, "Inspector disconnected before Guest entry");
                scope.throw_exception(e);
                return None;
            }
        }
        if let Some(inspector) = state.borrow().inspector.as_ref() {
            inspector.begin_entry();
        }
    }
    let module = modules::get(scope, entry)?;
    // A CommonJS entry executes synchronously. Its next-tick callbacks belong
    // before the first engine Promise checkpoint, whereas ESM entry evaluation
    // runs as a Promise job and therefore keeps its Promise jobs first.
    let commonjs_entry = state
        .borrow()
        .definitions
        .get(entry)
        .and_then(|definition| definition["format"].as_str())
        == Some("commonjs");
    let (evaluated, execution) = modules::evaluate(scope, module)?;
    if commonjs_entry && evaluated.state() == v8::PromiseState::Fulfilled {
        call(scope, controller, "drainNextTicks", &[])?;
    }
    // CommonJS throws synchronously before queued jobs may run. Standalone
    // ESM entry evaluation is a Promise job, so earlier Promise jobs run
    // before its failure is reported (Node 22 entry semantics). A configured
    // Host closes control after failure; do not reenter Guest jobs while it
    // performs that cleanup.
    if !commonjs_entry
        && state.borrow().remote.is_none()
        && evaluated.state() == v8::PromiseState::Rejected
    {
        scope.perform_microtask_checkpoint();
        if scope.is_execution_terminating() {
            return None;
        }
    }
    let evaluated_result = drive_promise(scope, evaluated, state, expired, None);
    crate::observer::finished(
        scope,
        execution,
        if evaluated_result.is_some() {
            "completed"
        } else if expired.load(Ordering::Acquire) {
            "terminated"
        } else {
            "threw"
        },
    );
    evaluated_result?;
    let completion =
        v8::Local::<v8::Promise>::try_from(call(scope, controller, "complete", &[])?).ok()?;
    drive_promise(scope, completion, state, expired, None)?;
    loop {
        while state.borrow().wakeup.is_some()
            || !state.borrow().imports.is_empty()
            || control_active(state)
        {
            if !pump(scope, state, expired)?
                && state.borrow().wakeup.is_none()
                && !state.borrow().imports.is_empty()
                && !control_active(state)
            {
                let e = crate::state::error(
                    scope,
                    "Unsettled dynamic import without active Runtime work",
                );
                scope.throw_exception(e);
                return None;
            }
        }
        // Promise jobs may enqueue next ticks or timers even after all earlier
        // Runtime work has settled. Revisit the loop before declaring idle.
        checkpoint_and_rejections(scope, state)?;
        if state.borrow().wakeup.is_none()
            && state.borrow().imports.is_empty()
            && !control_active(state)
        {
            break;
        }
    }
    let exit_code = call(scope, controller, "exitCode", &[])?.int32_value(scope)?;
    let disposed = call(scope, controller, "dispose", &[])?;
    if let Ok(promise) = v8::Local::<v8::Promise>::try_from(disposed) {
        drive_promise(scope, promise, state, expired, None)?;
    }
    Some(exit_code)
}

fn close_control(
    scope: &mut v8::PinScope,
    state: &SharedState,
    expired: &AtomicBool,
) -> Option<()> {
    if state.borrow().remote.is_none() {
        return Some(());
    }
    state.borrow_mut().closing = true;
    state.borrow_mut().remote.as_mut()?.begin_close();
    let closed = crate::control::invoke_promise(scope, "close", &[])?;
    let closed = v8::Local::new(scope, closed);
    drive_promise(
        scope,
        closed,
        state,
        expired,
        Some(PromiseFailure::Host("Host Runtime shutdown failed")),
    )
}

enum PromiseFailure<'a> {
    Host(&'a str),
    Planner,
}

fn drive_promise(
    scope: &mut v8::PinScope,
    promise: v8::Local<v8::Promise>,
    state: &SharedState,
    expired: &AtomicBool,
    host_error: Option<PromiseFailure<'_>>,
) -> Option<()> {
    crate::rejection::handle(scope, promise);
    let mut idle_turns = 0;
    while promise.state() == v8::PromiseState::Pending {
        let progressed = pump(scope, state, expired)?;
        if !progressed && state.borrow().wakeup.is_none() && !control_active(state) {
            idle_turns += 1;
        } else {
            idle_turns = 0;
        }
        if idle_turns >= 2 && promise.state() == v8::PromiseState::Pending {
            let e = crate::state::error(
                scope,
                "Unsettled top-level await without active Runtime work",
            );
            scope.throw_exception(e);
            return None;
        }
    }
    if promise.state() == v8::PromiseState::Rejected {
        let exception = match host_error {
            Some(PromiseFailure::Host(message)) => crate::state::error(scope, message),
            Some(PromiseFailure::Planner) => crate::module_planner::rejection(scope, promise),
            None => promise.result(scope),
        };
        scope.throw_exception(exception);
        return None;
    }
    Some(())
}

fn checkpoint_and_rejections(scope: &mut v8::PinScope, state: &SharedState) -> Option<()> {
    let controller = state.borrow().controller.clone();
    loop {
        scope.perform_microtask_checkpoint();
        if scope.is_execution_terminating() || state.borrow().exit_code.is_some() {
            return None;
        }
        let Some(controller) = controller.as_ref() else {
            break;
        };
        let controller = v8::Local::new(scope, controller);
        // Promise jobs can enqueue next ticks that attach a rejection handler.
        // Drain only that phase before judging the rejection; ordinary timers,
        // imports, and Host completions must remain behind the fatal boundary.
        let drained = call(scope, controller, "drainNextTicks", &[])?.boolean_value(scope);
        if state.borrow().exit_code.is_some() {
            return None;
        }
        if !drained {
            break;
        }
    }
    crate::rejection::check(scope)
}

fn pump(scope: &mut v8::PinScope, state: &SharedState, expired: &AtomicBool) -> Option<bool> {
    v8::scope!(let scope, scope);
    if expired.load(Ordering::Acquire) || state.borrow().exit_code.is_some() {
        return None;
    }
    if state.borrow().closing {
        return crate::control::pump(scope);
    }
    crate::wasm::check_deadlines(scope)?;
    let mut progressed = false;
    let inspector = { state.borrow_mut().inspector.take() };
    if let Some(inspector) = inspector {
        progressed |= inspector.pump();
        state.borrow_mut().inspector = Some(inspector);
    }
    while v8::Platform::pump_message_loop(&v8::V8::get_current_platform(), scope, false) {
        progressed = true;
    }
    // Stop at the rejection boundary before imports, Host control, or timers.
    checkpoint_and_rejections(scope, state)?;
    progressed |= modules::pump_imports(scope)?;
    progressed |= crate::control::pump(scope)?;
    checkpoint_and_rejections(scope, state)?;
    let deadline = state.borrow().wakeup;
    if let Some(deadline) = deadline {
        progressed = true;
        let now = state.borrow().start.elapsed().as_secs_f64() * 1000.0;
        if deadline <= now {
            let controller = state.borrow().controller.clone();
            if let Some(controller) = controller {
                let controller = v8::Local::new(scope, controller);
                call(scope, controller, "turn", &[])?;
                checkpoint_and_rejections(scope, state)?;
            }
        } else {
            std::thread::sleep(Duration::from_secs_f64(
                ((deadline - now) / 1000.0).min(0.005),
            ));
        }
    }
    if !progressed && control_active(state) {
        let delay = if state.borrow().wasm_work.active()
            || state
                .borrow()
                .imports
                .iter()
                .any(|item| item.module_gate.is_some())
        {
            Duration::from_millis(1)
        } else {
            state.borrow().remote.as_ref()?.idle_delay()
        };
        std::thread::sleep(delay);
    }
    Some(progressed)
}

fn control_active(state: &SharedState) -> bool {
    let state = state.borrow();
    state
        .inspector
        .as_ref()
        .is_some_and(crate::inspector::InspectorRuntime::active)
        || state.wasm_work.active()
        || state.imports.iter().any(|item| item.module_gate.is_some())
        || state
            .remote
            .as_ref()
            .is_some_and(crate::control::RemoteControl::active)
}
