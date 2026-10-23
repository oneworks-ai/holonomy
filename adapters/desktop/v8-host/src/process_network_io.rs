//! Host-isolate-only Process socket transport. Guest V8 never receives these
//! bindings; completion resolvers remain on the Host worker thread.
use crate::state::{error, state};
use holonomy_desktop_host::NativeProcessNetwork;
use std::{collections::HashMap, time::Instant};

struct Pending {
    resolver: v8::Global<v8::PromiseResolver>,
    context: v8::Global<v8::Context>,
}

pub(crate) struct ProcessNetworkIo {
    network: NativeProcessNetwork,
    pending: HashMap<u64, Pending>,
}

impl ProcessNetworkIo {
    pub(crate) fn new(epoch: Instant) -> Self {
        Self {
            network: NativeProcessNetwork::new(epoch),
            pending: HashMap::new(),
        }
    }

    pub(crate) fn active(&self) -> bool {
        self.network.active() || !self.pending.is_empty()
    }
}

fn network_error<'s>(scope: &mut v8::PinScope<'s, '_>, code: &str) -> v8::Local<'s, v8::Value> {
    let exception = error(scope, "Native Process network operation failed");
    let object = v8::Local::<v8::Object>::try_from(exception).unwrap();
    let key = v8::String::new(scope, "code").unwrap();
    let value = v8::String::new(scope, code).unwrap();
    object.set(scope, key.into(), value.into());
    exception
}

pub(crate) fn dispatch(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut output: v8::ReturnValue,
    operation: i32,
) {
    let shared = state(scope);
    let epoch = shared.borrow().start;
    if operation == 2 {
        let id = args.get(0).integer_value(scope).unwrap_or(0);
        if id > 0
            && let Some(io) = shared
                .borrow_mut()
                .control
                .as_mut()
                .and_then(|control| control.process_network.as_mut())
        {
            io.network.cancel(id as u64);
        }
        return;
    }
    let Ok(value) = v8::Local::<v8::String>::try_from(args.get(0)) else {
        let exception = error(scope, "Invalid Process network request");
        scope.throw_exception(exception);
        return;
    };
    if value.utf8_length(scope) > 128 * 1024 {
        let exception = error(scope, "Process network request exceeds bounds");
        scope.throw_exception(exception);
        return;
    }
    let input = value.to_rust_string_lossy(scope);
    if operation == 0 {
        let text = {
            let mut state = shared.borrow_mut();
            let Some(control) = state.control.as_mut() else {
                return;
            };
            control
                .process_network
                .get_or_insert_with(|| ProcessNetworkIo::new(epoch))
                .network
                .sync(&input)
        };
        if let Some(value) = v8::String::new(scope, &text) {
            output.set(value.into());
        }
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
            .process_network
            .get_or_insert_with(|| ProcessNetworkIo::new(epoch))
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
                .process_network
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
            let exception = network_error(scope, code);
            resolver.reject(scope, exception);
            0
        }
    };
    let object = v8::Object::new(scope);
    let key = v8::String::new(scope, "id").unwrap();
    object.set(scope, key.into(), v8::Number::new(scope, id as f64).into());
    let key = v8::String::new(scope, "promise").unwrap();
    object.set(scope, key.into(), promise.into());
    output.set(object.into());
}

pub(crate) fn pump(scope: &mut v8::PinScope) -> Option<bool> {
    let shared = state(scope);
    let completed = {
        let mut state = shared.borrow_mut();
        let Some(io) = state
            .control
            .as_mut()
            .and_then(|control| control.process_network.as_mut())
        else {
            return Some(false);
        };
        io.network
            .poll()
            .into_iter()
            .filter_map(|(id, result)| io.pending.remove(&id).map(|pending| (pending, result)))
            .collect::<Vec<_>>()
    };
    let progress = !completed.is_empty();
    for (pending, result) in completed {
        let context = v8::Local::new(scope, pending.context);
        let scope = &mut v8::ContextScope::new(scope, context);
        let resolver = v8::Local::new(scope, pending.resolver);
        match result {
            Ok(value) => {
                let text = value.to_string();
                if text.len() > 128 * 1024 {
                    let exception = network_error(scope, "resource.byte_limit");
                    resolver.reject(scope, exception)?;
                } else {
                    let text = v8::String::new(scope, &text)?;
                    resolver.resolve(scope, text.into())?;
                }
            }
            Err(code) => {
                let exception = network_error(scope, code);
                resolver.reject(scope, exception)?;
            }
        }
    }
    Some(progress)
}
