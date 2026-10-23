use crate::state::{error, state};
use holonomy_desktop_host::NativeNetwork;
use std::{collections::HashMap, time::Instant};

struct Pending {
    resolver: v8::Global<v8::PromiseResolver>,
    context: v8::Global<v8::Context>,
}
pub struct NetworkIo {
    network: NativeNetwork,
    pending: HashMap<u64, Pending>,
}
impl NetworkIo {
    pub fn new(epoch: Instant) -> Self {
        Self {
            network: NativeNetwork::new(epoch),
            pending: HashMap::new(),
        }
    }
    pub fn active(&self) -> bool {
        self.network.active() || !self.pending.is_empty()
    }
}
pub fn dispatch(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut output: v8::ReturnValue,
    index: i32,
) {
    let shared = state(scope);
    let epoch = shared.borrow().start;
    if index == 7 {
        output.set_double(epoch.elapsed().as_secs_f64() * 1000.0);
        return;
    }
    if index == 6 {
        let id = args.get(0).integer_value(scope).unwrap_or(0) as u64;
        if let Some(io) = shared
            .borrow_mut()
            .control
            .as_mut()
            .and_then(|c| c.network.as_mut())
        {
            io.network.cancel(id);
        }
        return;
    }
    if !args.get(0).is_string() {
        let e = error(scope, "Invalid network request");
        scope.throw_exception(e);
        return;
    }
    let input = args.get(0).to_rust_string_lossy(scope);
    if input.len() > 12 * 1024 * 1024 {
        let e = error(scope, "Network transport request limit");
        scope.throw_exception(e);
        return;
    }
    if index == 4 {
        let text = {
            let mut state = shared.borrow_mut();
            let Some(control) = state.control.as_mut() else {
                return;
            };
            control
                .network
                .get_or_insert_with(|| NetworkIo::new(epoch))
                .network
                .sync(&input)
        };
        output.set(v8::String::new(scope, &text).unwrap().into());
        return;
    }
    let Some(resolver) = v8::PromiseResolver::new(scope) else {
        return;
    };
    let promise = resolver.get_promise(scope);
    let started = {
        let mut state = shared.borrow_mut();
        let Some(control) = state.control.as_mut() else {
            return;
        };
        control
            .network
            .get_or_insert_with(|| NetworkIo::new(epoch))
            .network
            .start(&input)
    };
    let id = match started {
        Ok(id) => {
            let context = scope.get_current_context();
            shared
                .borrow_mut()
                .control
                .as_mut()
                .unwrap()
                .network
                .as_mut()
                .unwrap()
                .pending
                .insert(
                    id,
                    Pending {
                        resolver: v8::Global::new(scope, resolver),
                        context: v8::Global::new(scope, context),
                    },
                );
            id
        }
        Err(code) => {
            let e = network_error(scope, code);
            resolver.reject(scope, e);
            0
        }
    };
    let object = v8::Object::new(scope);
    let key = v8::String::new(scope, "id").unwrap();
    let id = v8::Number::new(scope, id as f64);
    object.set(scope, key.into(), id.into());
    let key = v8::String::new(scope, "promise").unwrap();
    object.set(scope, key.into(), promise.into());
    output.set(object.into());
}
fn network_error<'s>(scope: &mut v8::PinScope<'s, '_>, code: &str) -> v8::Local<'s, v8::Value> {
    let e = error(scope, "Native network operation failed");
    let object = v8::Local::<v8::Object>::try_from(e).unwrap();
    let key = v8::String::new(scope, "code").unwrap();
    let code = v8::String::new(scope, code).unwrap();
    object.set(scope, key.into(), code.into());
    e
}
pub fn pump(scope: &mut v8::PinScope) -> Option<bool> {
    let shared = state(scope);
    let finished = {
        let mut state = shared.borrow_mut();
        let Some(io) = state.control.as_mut().and_then(|c| c.network.as_mut()) else {
            return Some(false);
        };
        io.network
            .poll()
            .into_iter()
            .filter_map(|(id, result)| io.pending.remove(&id).map(|pending| (pending, result)))
            .collect::<Vec<_>>()
    };
    let progress = !finished.is_empty();
    for (pending, result) in finished {
        let context = v8::Local::new(scope, pending.context);
        let scope = &mut v8::ContextScope::new(scope, context);
        let resolver = v8::Local::new(scope, pending.resolver);
        match result {
            Ok(value) => {
                let text = v8::String::new(scope, &value.to_string())?;
                resolver.resolve(scope, text.into())?;
            }
            Err(code) => {
                let e = network_error(scope, code);
                resolver.reject(scope, e)?;
            }
        }
    }
    Some(progress)
}
