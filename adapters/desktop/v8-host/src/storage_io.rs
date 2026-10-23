use crate::state::{error, state};
use holonomy_desktop_host::{NativeStorage, StorageInstallation};
use std::collections::HashMap;

struct Pending {
    resolver: v8::Global<v8::PromiseResolver>,
    context: v8::Global<v8::Context>,
}
pub struct StorageIo {
    storage: Result<NativeStorage, String>,
    pending: HashMap<u64, Pending>,
}
impl StorageIo {
    pub fn new(installation: StorageInstallation) -> Self {
        Self {
            storage: NativeStorage::new(installation),
            pending: HashMap::new(),
        }
    }
    pub fn active(&self) -> bool {
        !self.pending.is_empty() || self.storage.as_ref().is_ok_and(NativeStorage::active)
    }
    pub fn available(&self) -> bool {
        self.storage.is_ok()
    }
}
fn storage_error<'s>(scope: &mut v8::PinScope<'s, '_>, code: &str) -> v8::Local<'s, v8::Value> {
    let exception = error(scope, "Native Storage operation failed");
    let object = v8::Local::<v8::Object>::try_from(exception).unwrap();
    let key = v8::String::new(scope, "code").unwrap();
    let value = v8::String::new(scope, code).unwrap();
    object.set(scope, key.into(), value.into());
    exception
}
pub fn dispatch(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut output: v8::ReturnValue,
    cancel: bool,
) {
    let shared = state(scope);
    if cancel {
        let id = args.get(0).integer_value(scope).unwrap_or(0) as u64;
        if let Some(io) = shared
            .borrow_mut()
            .control
            .as_mut()
            .and_then(|c| c.storage.as_mut())
            && let Ok(storage) = &mut io.storage
        {
            storage.cancel(id);
        }
        return;
    }
    let Some(value) = v8::Local::<v8::String>::try_from(args.get(0)).ok() else {
        let exception = error(scope, "Invalid Native Storage request");
        scope.throw_exception(exception);
        return;
    };
    if value.utf8_length(scope) > 2 * 1024 * 1024 {
        let exception = error(scope, "Native Storage request limit");
        scope.throw_exception(exception);
        return;
    }
    let encoded = value.to_rust_string_lossy(scope);
    let Some(resolver) = v8::PromiseResolver::new(scope) else {
        return;
    };
    let promise = resolver.get_promise(scope);
    let started = {
        let mut state = shared.borrow_mut();
        state
            .control
            .as_mut()
            .and_then(|control| control.storage.as_mut())
            .and_then(|io| io.storage.as_mut().ok())
            .map(|storage| storage.start(&encoded))
            .unwrap_or(Err("storage.not_supported"))
    };
    let id = match started {
        Ok(id) => {
            let context = scope.get_current_context();
            shared
                .borrow_mut()
                .control
                .as_mut()
                .unwrap()
                .storage
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
            let exception = storage_error(scope, code);
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
pub fn pump(scope: &mut v8::PinScope) -> Option<bool> {
    let shared = state(scope);
    let finished = {
        let mut state = shared.borrow_mut();
        let Some(io) = state
            .control
            .as_mut()
            .and_then(|control| control.storage.as_mut())
        else {
            return Some(false);
        };
        let Ok(storage) = &mut io.storage else {
            return Some(false);
        };
        storage
            .poll()
            .into_iter()
            .filter_map(|(id, value)| io.pending.remove(&id).map(|pending| (pending, value)))
            .collect::<Vec<_>>()
    };
    let progress = !finished.is_empty();
    for (pending, value) in finished {
        let context = v8::Local::new(scope, pending.context);
        let scope = &mut v8::ContextScope::new(scope, context);
        let resolver = v8::Local::new(scope, pending.resolver);
        let text = v8::String::new(scope, &value.to_string())?;
        resolver.resolve(scope, text.into())?;
    }
    Some(progress)
}
