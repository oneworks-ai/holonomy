use super::{
    calls,
    protocol::{CallId, Completion, ControlFailure},
    state::PendingHost,
    transport::{AsyncMethod, Command, Shared, WorkerChannels},
};
use crate::state::SharedState;
use std::{
    collections::VecDeque,
    sync::{
        atomic::Ordering,
        mpsc::{RecvTimeoutError, TrySendError},
    },
};

fn accept(
    scope: &mut v8::PinScope,
    state: &SharedState,
    command: Command,
    initialize: &mut Option<CallId>,
    failures: &mut VecDeque<Completion>,
    gates: &mut super::gates::Gates,
) -> Option<()> {
    match command {
        Command::Gate {
            encoded,
            source_prefix,
            ticket,
            reply,
        } => gates.accept(scope, encoded, source_prefix, ticket, reply)?,
        Command::Sync {
            method,
            arguments,
            reply,
        } => {
            let response = calls::invoke_host(scope, method.name(), &arguments)
                .ok_or(ControlFailure::ExecutionFailed);
            let _ = reply.try_send(response);
        }
        Command::Async { id, method } => {
            let cleanup = method.cleanup();
            let allow_undefined = !matches!(method, AsyncMethod::Invoke { .. });
            let accepted = {
                let mut state = state.borrow_mut();
                let pending = &mut state.control.as_mut()?.pending;
                let reservation = PendingHost {
                    promise: None,
                    allow_undefined,
                };
                if cleanup {
                    pending.admit_cleanup(id, reservation)
                } else {
                    pending.admit(id, reservation)
                }
            };
            if !accepted {
                return None;
            } // Protocol violation is generation-fatal, before Host side effects.
            let promise = match method {
                AsyncMethod::Initialize(plan) => {
                    *initialize = Some(id);
                    calls::invoke_promise(scope, "initialize", &[plan])
                }
                AsyncMethod::Close => {
                    if let Some(watch) = state.borrow_mut().control.as_mut()?.watch.as_mut() {
                        watch.stop();
                    }
                    calls::invoke_promise(scope, "close", &[])
                }
                AsyncMethod::Invoke {
                    json,
                    cancellation_id,
                    aborted,
                    network_request_body_base64,
                } => calls::invoke_async_host(
                    scope,
                    &json,
                    &cancellation_id,
                    aborted,
                    network_request_body_base64.as_deref().map(String::as_str),
                ),
            };
            let mut state = state.borrow_mut();
            let pending = &mut state.control.as_mut()?.pending;
            if let Some(promise) = promise {
                pending.get_mut(id)?.promise = Some(promise);
            } else {
                pending.take(id);
                failures.push_back(Completion {
                    id,
                    result: Err(ControlFailure::ExecutionFailed),
                });
            }
        }
    }
    Some(())
}

fn drain_observers(scope: &mut v8::PinScope, shared: &Shared, channels: &WorkerChannels) {
    // A dedicated channel preserves command/Gate capacity under Observer bursts.
    // Its 64 bounded, <=8 KiB owned messages have no Guest completion path.
    for _ in 0..64 {
        let Ok(encoded) = channels.observers.try_recv() else {
            break;
        };
        let _ = calls::invoke_host(scope, "observeEngineEvent", &[encoded]);
    }
    let dropped = shared.observer_dropped.swap(0, Ordering::AcqRel);
    if dropped > 0 {
        eprintln!("holo observer transport.dropped {dropped}");
    }
}

pub(super) fn run(
    scope: &mut v8::PinScope,
    state: &SharedState,
    shared: &Shared,
    channels: &WorkerChannels,
) -> Option<()> {
    let mut outbox: Option<Vec<Completion>> = None;
    let mut initialize = None;
    let mut failures = VecDeque::new();
    let mut gates = super::gates::Gates::default();
    while !shared.stopped() {
        v8::scope!(let scope, scope);
        let delay = if gates.active() {
            std::time::Duration::from_millis(1)
        } else {
            state.borrow().control.as_ref()?.idle_delay()
        };
        let command = match channels.commands.recv_timeout(delay) {
            Ok(envelope) => Some(envelope.command),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return Some(()),
        };
        // Terminal Observer messages are produced before Guest requests close.
        // Start their Host callbacks before close fences the registry.
        if matches!(
            &command,
            Some(Command::Async {
                method: AsyncMethod::Close,
                ..
            })
        ) {
            drain_observers(scope, shared, channels);
            scope.perform_microtask_checkpoint();
        }
        if let Some(command) = command {
            gates.cancel_expired(scope)?;
            accept(
                scope,
                state,
                command,
                &mut initialize,
                &mut failures,
                &mut gates,
            )?;
        }
        drain_observers(scope, shared, channels);
        if scope.is_execution_terminating() {
            return None;
        }
        while v8::Platform::pump_message_loop(&v8::V8::get_current_platform(), scope, false) {}
        scope.perform_microtask_checkpoint();
        crate::modules::pump_imports(scope)?;
        gates.pump(scope)?;
        #[cfg(feature = "v86-backend")]
        state
            .borrow_mut()
            .control
            .as_mut()?
            .vm
            .tick(|| scope.is_execution_terminating())
            .ok()?;
        let (_, mut completed) =
            super::pump::pump_host(scope, outbox.is_none() && failures.is_empty())?;
        if outbox.is_none() && completed.is_empty() {
            for _ in 0..64 {
                if let Some(failure) = failures.pop_front() {
                    completed.push(failure);
                } else {
                    break;
                }
            }
        }
        for completion in &completed {
            if initialize == Some(completion.id) {
                initialize = None;
                if completion.result.is_ok() {
                    crate::plugin_watch::arm(state);
                }
            }
        }
        // One bounded batch in the channel and one local outbox. Host work still
        // advances under Guest backpressure, but we stop copying more terminals.
        if !completed.is_empty() {
            debug_assert!(outbox.is_none());
            outbox = Some(completed);
        }
        crate::rejection::check(scope)?;
        let active = state.borrow().control.as_ref()?.active()
            || !state.borrow().imports.is_empty()
            || outbox.is_some()
            || !failures.is_empty();
        let active = active || gates.active();
        shared.active.store(active, Ordering::Release);
        let busy = state.borrow().control.as_ref()?.has_work()
            || !state.borrow().imports.is_empty()
            || outbox.is_some()
            || !failures.is_empty();
        let busy = busy || gates.active();
        shared.busy.store(busy, Ordering::Release);
        if let Some(batch) = outbox.take() {
            match channels.completions.try_send(batch) {
                Ok(()) => {}
                Err(TrySendError::Full(batch)) => outbox = Some(batch),
                Err(TrySendError::Disconnected(_)) => return Some(()),
            }
        }
    }
    Some(())
}
