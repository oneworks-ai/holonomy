use super::{
    calls::handles,
    events::deliver_events,
    protocol::{Completion, ControlFailure, ControlValue, MAX_MESSAGE_BYTES},
};
use crate::state::{error, state};

/// Advances Host-only work and returns owned terminals, never Guest handles.
pub(super) fn pump_host(
    scope: &mut v8::PinScope,
    capture: bool,
) -> Option<(bool, Vec<Completion>)> {
    let Some((context, api)) = handles(scope) else {
        return Some((false, Vec::new()));
    };
    let shared = state(scope);
    let now = shared.borrow().start.elapsed().as_secs_f64() * 1000.0;
    let (due, mut pending) = {
        let mut state = shared.borrow_mut();
        let host = state.control.as_mut()?;
        let mut ids = host
            .timers
            .iter()
            .filter(|(_, entry)| entry.0 <= now)
            .map(|(id, _)| *id)
            .collect::<Vec<_>>();
        ids.sort();
        let due = ids
            .into_iter()
            .filter_map(|id| host.timers.remove(&id).map(|entry| entry.1))
            .collect::<Vec<_>>();
        // Keep the admission cutoff before callbacks/checkpoints: work admitted
        // during this pump belongs to its next completion batch.
        let pending = host
            .pending
            .pending()
            .filter(|_| capture)
            .filter_map(|(id, pending)| {
                pending
                    .promise
                    .as_ref()
                    .map(|promise| (*id, promise.clone(), pending.allow_undefined))
            })
            .collect::<Vec<_>>();
        (due, pending)
    };
    pending.sort_by_key(|(id, _, _)| id.sequence);
    let mut progress = !due.is_empty();
    progress |= crate::plugin_watch::pump(scope)?;
    progress |= crate::network_io::pump(scope)?;
    #[cfg(feature = "v86-backend")]
    {
        progress |= crate::process_network_io::pump(scope)?;
    }
    progress |= crate::storage_io::pump(scope)?;
    let mut completions = Vec::new();
    {
        let context = v8::Local::new(scope, &context);
        let scope = &mut v8::ContextScope::new(scope, context);
        let api = v8::Local::new(scope, api);
        for callback in due {
            let callback = v8::Local::new(scope, callback);
            callback.call(scope, api.into(), &[])?;
        }
        scope.perform_microtask_checkpoint();
        let mut copied_bytes = 0;
        for (id, promise, allow_undefined) in pending {
            let promise = v8::Local::new(scope, promise);
            let result = match promise.state() {
                v8::PromiseState::Pending => continue,
                v8::PromiseState::Rejected => Err(ControlFailure::ExecutionFailed),
                v8::PromiseState::Fulfilled => {
                    let value = promise.result(scope);
                    match super::value::snapshot(
                        scope,
                        value,
                        allow_undefined,
                        MAX_MESSAGE_BYTES,
                        MAX_MESSAGE_BYTES - copied_bytes,
                    ) {
                        super::value::Snapshot::Deferred => break,
                        super::value::Snapshot::Complete(result, size) => {
                            copied_bytes += size;
                            result
                        }
                    }
                }
            };
            if shared
                .borrow_mut()
                .control
                .as_mut()?
                .pending
                .take(id)
                .is_some()
            {
                completions.push(Completion { id, result });
            }
            if completions.len() >= 64 {
                break;
            }
        }
    }
    progress |= !completions.is_empty();
    Some((progress, completions))
}

/// Only this side resolves Guest promises. Unknown/late terminals are inert.
fn deliver_completion(scope: &mut v8::PinScope, completion: Completion) -> Option<bool> {
    let pending = state(scope)
        .borrow_mut()
        .remote
        .as_mut()?
        .guest
        .pending
        .take(completion.id);
    let Some(pending) = pending else {
        return Some(false);
    };
    let context = v8::Local::new(scope, pending.context);
    let scope = &mut v8::ContextScope::new(scope, context);
    let resolver = v8::Local::new(scope, pending.resolver);
    match completion.result {
        Ok(ControlValue::Text(text)) => {
            let text = v8::String::new(scope, &text)?;
            resolver.resolve(scope, text.into())?;
        }
        Ok(ControlValue::Undefined) => {
            let value = v8::undefined(scope);
            resolver.resolve(scope, value.into())?;
        }
        Err(_) => {
            let e = error(scope, "Host capability execution failed");
            resolver.reject(scope, e)?;
        }
    }
    Some(true)
}

pub fn pump(scope: &mut v8::PinScope) -> Option<bool> {
    let completions = {
        let shared = state(scope);
        let state = shared.borrow();
        let Some(remote) = state.remote.as_ref() else {
            return Some(false);
        };
        remote.poll()
    };
    let completions = match completions {
        Ok(value) => value,
        Err(_) => {
            let e = error(scope, "Host worker execution failed");
            scope.throw_exception(e);
            return None;
        }
    };
    let mut progress = false;
    for completion in completions {
        progress |= deliver_completion(scope, completion)?;
    }
    if !state(scope).borrow().closing {
        progress |= deliver_events(scope)?;
        progress |= crate::port_bridge::pump(scope)?;
    }
    Some(progress)
}
