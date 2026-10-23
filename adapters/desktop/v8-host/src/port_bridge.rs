use crate::{
    control,
    state::{error, state},
};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Clone)]
struct Call {
    sink: v8::Global<v8::Function>,
    resource_sink: v8::Global<v8::Function>,
    context: v8::Global<v8::Context>,
}
#[derive(Default)]
pub struct PortBridge {
    calls: HashMap<String, Call>,
    resources: HashMap<String, Call>,
    queued: bool,
}
impl PortBridge {
    pub fn active(&self) -> bool {
        !self.calls.is_empty() || self.queued
    }
}
pub fn dispatch(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments) -> Option<()> {
    if !args.get(0).is_string() || !args.get(1).is_string() {
        let e = error(scope, "Invalid NativePort request");
        scope.throw_exception(e);
        return None;
    }
    let request = args.get(0).to_rust_string_lossy(scope);
    let context = args.get(1).to_rust_string_lossy(scope);
    if request.len() + context.len() > 12 * 1024 * 1024 {
        let e = error(scope, "NativePort request limit");
        scope.throw_exception(e);
        return None;
    }
    let request: Value = serde_json::from_str(&request).ok()?;
    let context: Value = serde_json::from_str(&context).ok()?;
    let token = context["callToken"].as_str()?.to_string();
    let sink = v8::Local::<v8::Function>::try_from(args.get(2)).ok()?;
    let resource_sink = v8::Local::<v8::Function>::try_from(args.get(3)).ok()?;
    let shared = state(scope);
    let current = scope.get_current_context();
    {
        let mut state = shared.borrow_mut();
        let port = &mut state.remote.as_mut()?.guest.port;
        if token.len() > 256
            || port.calls.len() >= 4096
            || port.calls.contains_key(&token)
            || port.resources.contains_key(&token)
        {
            drop(state);
            let e = error(scope, "NativePort call identity rejected");
            scope.throw_exception(e);
            return None;
        }
        port.calls.insert(
            token.clone(),
            Call {
                sink: v8::Global::new(scope, sink),
                resource_sink: v8::Global::new(scope, resource_sink),
                context: v8::Global::new(scope, current),
            },
        );
    }
    let result = control::invoke(
        scope,
        "portCommand",
        &[json!({"kind":"dispatch","request":request,"context":context}).to_string()],
    );
    match result {
        Some(result) => {
            deliver(scope, &result)?;
        }
        None => {
            shared
                .borrow_mut()
                .remote
                .as_mut()?
                .guest
                .port
                .calls
                .remove(&token);
            return None;
        }
    }
    Some(())
}
pub fn command(scope: &mut v8::PinScope, json: &str) -> Option<()> {
    let input: Value = serde_json::from_str(json).ok()?;
    let result = control::invoke(scope, "portCommand", &[json.into()])?;
    deliver(scope, &result)?;
    let shared = state(scope);
    let mut state = shared.borrow_mut();
    let port = &mut state.remote.as_mut()?.guest.port;
    match input["kind"].as_str() {
        Some("cancel") => {
            port.calls.remove(input["callToken"].as_str()?);
        }
        Some("close") => {
            port.resources.remove(input["ownerCallToken"].as_str()?);
        }
        Some("dispose") => {
            port.calls.clear();
            port.resources.clear();
            port.queued = false;
        }
        _ => {}
    }
    Some(())
}
fn deliver(scope: &mut v8::PinScope, json: &str) -> Option<bool> {
    let batch: Value = serde_json::from_str(json).ok()?;
    let events = batch["events"].as_array()?;
    state(scope).borrow_mut().remote.as_mut()?.guest.port.queued = batch["remaining"].as_u64()? > 0;
    for packet in events {
        let token = packet["callToken"].as_str()?;
        let resource = packet["channel"] == "resource";
        let event = &packet["event"];
        let binding = {
            let shared = state(scope);
            let mut state = shared.borrow_mut();
            let port = &mut state.remote.as_mut()?.guest.port;
            if resource {
                port.resources.remove(token)
            } else {
                let call = port.calls.get(token).cloned();
                if matches!(event["type"].as_str(), Some("result" | "error" | "end")) {
                    port.calls.remove(token);
                    if event["resources"].as_array().is_some_and(|r| !r.is_empty())
                        && let Some(call) = &call
                    {
                        port.resources.insert(token.into(), call.clone());
                    }
                }
                call
            }
        };
        let Some(binding) = binding else {
            continue;
        };
        let context = v8::Local::new(scope, binding.context);
        let scope = &mut v8::ContextScope::new(scope, context);
        let callback = v8::Local::new(
            scope,
            if resource {
                binding.resource_sink
            } else {
                binding.sink
            },
        );
        let text = v8::String::new(scope, &event.to_string())?;
        let receiver = v8::undefined(scope);
        callback.call(scope, receiver.into(), &[text.into()])?;
    }
    Some(!events.is_empty())
}
pub fn pump(scope: &mut v8::PinScope) -> Option<bool> {
    if state(scope).borrow().remote.is_none() {
        return Some(false);
    }
    let result = control::invoke(scope, "drainPortEvents", &[])?;
    deliver(scope, &result)
}
