use super::{state::PendingGuest, transport::AsyncMethod};
use crate::state::{error, state};

// Allocate the Guest reservation before entering Host JS; completions carry only
// CallId + owned data back to this registry, never the Host Promise itself.
fn start<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    method: AsyncMethod,
) -> Option<v8::Local<'s, v8::Promise>> {
    let cleanup = method.cleanup();
    let resolver = v8::PromiseResolver::new(scope)?;
    let promise = resolver.get_promise(scope);
    let shared = state(scope);
    let id = {
        let state = shared.borrow();
        let pending = &state.remote.as_ref()?.guest.pending;
        if cleanup {
            pending.next_cleanup_id()
        } else {
            pending.next_id()
        }
    };
    let Some(id) = id else {
        let e = error(scope, "Host capability pending limit");
        resolver.reject(scope, e)?;
        return Some(promise);
    };
    let context = scope.get_current_context();
    let pending = PendingGuest {
        resolver: v8::Global::new(scope, resolver),
        context: v8::Global::new(scope, context),
    };
    let admitted = {
        let mut state = shared.borrow_mut();
        let ledger = &mut state.remote.as_mut()?.guest.pending;
        if cleanup {
            ledger.admit_cleanup(id, pending)
        } else {
            ledger.admit(id, pending)
        }
    };
    if !admitted {
        return None;
    }
    let accepted = shared.borrow().remote.as_ref()?.submit(id, method);
    if !accepted {
        shared.borrow_mut().remote.as_mut()?.guest.pending.take(id);
        let e = error(scope, "Host capability execution failed");
        resolver.reject(scope, e)?;
    }
    Some(promise)
}

pub fn invoke_async<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    json: &str,
    cancellation_id: &str,
    aborted: bool,
    network_request_body_base64: Option<&str>,
) -> Option<v8::Local<'s, v8::Promise>> {
    if cancellation_id.len() > 128 {
        return None;
    }
    start(
        scope,
        AsyncMethod::Invoke {
            json: json.into(),
            cancellation_id: cancellation_id.into(),
            aborted,
            network_request_body_base64: network_request_body_base64
                .map(|value| zeroize::Zeroizing::new(value.to_owned())),
        },
    )
}

pub fn invoke_promise(
    scope: &mut v8::PinScope,
    name: &str,
    arguments: &[String],
) -> Option<v8::Global<v8::Promise>> {
    let method = match (name, arguments) {
        ("initialize", [plan]) => AsyncMethod::Initialize(plan.clone()),
        ("close", []) => AsyncMethod::Close,
        _ => return None,
    };
    let promise = start(scope, method)?;
    Some(v8::Global::new(scope, promise))
}
