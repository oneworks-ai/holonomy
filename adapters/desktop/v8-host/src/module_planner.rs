//! One trusted shared-JS planner per isolate. Only bounded primitive strings
//! cross Contexts; Guest prototype mutations cannot affect source admission.
use crate::state::{property, state};
use holonomy_desktop_host::SourceReadPurpose;
const BOOTSTRAP: &str = include_str!("../generated/module-planner.js");

pub struct ModulePlanner {
    context: v8::Global<v8::Context>,
    api: v8::Global<v8::Object>,
}

pub fn initialize(scope: &mut v8::PinScope, definitions: &str) -> Option<()> {
    if definitions.len() > 1024 * 1024 || state(scope).borrow().planner.is_some() {
        return None;
    }
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    context.set_allow_generation_from_strings(false);
    v8::tc_scope!(let tc, scope);
    let initialized = (|| {
        let host = v8::Object::new(tc);
        let reader = v8::Function::new(tc, read_module)?;
        let key = v8::String::new(tc, "readModule")?;
        host.set(tc, key.into(), reader.into())?;
        let name = v8::String::new(tc, "__holoModulePlannerHost")?;
        context.global(tc).set(tc, name.into(), host.into())?;
        let source = v8::String::new(tc, BOOTSTRAP)?;
        let script = v8::Script::compile(tc, source, None)?;
        let create = v8::Local::<v8::Function>::try_from(script.run(tc)?).ok()?;
        let definitions = v8::String::new(tc, definitions)?;
        let api = create.call(tc, v8::undefined(tc).into(), &[definitions.into()])?;
        let api = v8::Local::<v8::Object>::try_from(api).ok()?;
        Some(ModulePlanner {
            context: v8::Global::new(tc, context),
            api: v8::Global::new(tc, api),
        })
    })();
    if let Some(planner) = initialized {
        state(tc).borrow_mut().planner = Some(planner);
        Some(())
    } else {
        tc.reset();
        None
    }
}

pub fn plan(
    scope: &mut v8::PinScope,
    specifier: &str,
    parent: &str,
) -> Option<v8::Global<v8::Promise>> {
    if specifier.len() > 4096 || parent.len() > 4096 {
        return None;
    }
    let (context, api) = {
        let shared = state(scope);
        let shared = shared.borrow();
        let planner = shared.planner.as_ref()?;
        (planner.context.clone(), planner.api.clone())
    };
    let context = v8::Local::new(scope, context);
    let scope = &mut v8::ContextScope::new(scope, context);
    v8::tc_scope!(let tc, scope);
    let result = (|| {
        let api = v8::Local::new(tc, api);
        let method = v8::Local::<v8::Function>::try_from(property(tc, api, "plan")?).ok()?;
        let specifier = v8::String::new(tc, specifier)?;
        let parent = v8::String::new(tc, parent)?;
        let result = method.call(tc, api.into(), &[specifier.into(), parent.into()])?;
        let promise = v8::Local::<v8::Promise>::try_from(result).ok()?;
        crate::rejection::handle(tc, promise);
        Some(v8::Global::new(tc, promise))
    })();
    if result.is_none() {
        tc.reset();
    }
    result
}

/// The private planner emits a code primitive, never an Error or Guest value.
/// Rebuild an Error in the receiving Context without reading any object slots.
pub fn rejection<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    promise: v8::Local<v8::Promise>,
) -> v8::Local<'s, v8::Value> {
    let reason = promise.result(scope);
    let code = v8::Local::<v8::String>::try_from(reason)
        .ok()
        .filter(|text| text.length() <= 96)
        .map(|text| text.to_rust_string_lossy(scope))
        .filter(|text| {
            text != "ERR_HOLONOMY_MODULE_PLAN_FAILED"
                && text.starts_with("ERR_")
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
        });
    let Some(code) = code else {
        return crate::state::error(scope, "Module planning failed");
    };
    let error = crate::state::error(scope, &code);
    if let (Ok(object), Some(key), Some(value)) = (
        v8::Local::<v8::Object>::try_from(error),
        v8::String::new(scope, "code"),
        v8::String::new(scope, &code),
    ) {
        object.create_data_property(scope, key.into(), value.into());
    }
    error
}

fn read_module(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut result: v8::ReturnValue,
) {
    let Ok(url) = v8::Local::<v8::String>::try_from(args.get(0)) else {
        return;
    };
    let url = url.to_rust_string_lossy(scope);
    let purpose = if args.length() < 2 || args.get(1).is_undefined() {
        SourceReadPurpose::Module
    } else {
        let Ok(purpose) = v8::Local::<v8::String>::try_from(args.get(1)) else {
            let error = crate::state::error(scope, "Module source is unavailable");
            scope.throw_exception(error);
            return;
        };
        match SourceReadPurpose::parse(&purpose.to_rust_string_lossy(scope)) {
            Ok(purpose) => purpose,
            Err(_) => {
                let error = crate::state::error(scope, "Module source is unavailable");
                scope.throw_exception(error);
                return;
            }
        }
    };
    let value = state(scope)
        .borrow_mut()
        .sources
        .as_mut()
        .ok_or_else(|| "Module source store is unavailable".to_string())
        .and_then(|sources| {
            sources
                .read_resource_with_purpose(&url, purpose)
                .map(|resource| {
                    resource.map(|resource| {
                        let mut value = serde_json::json!({
                            "bytes": &resource.bytes,
                            "sha256": &resource.sha256,
                            "canonicalUrl": &resource.canonical_url,
                        });
                        if resource.metadata_only {
                            value["metadataOnly"] = serde_json::json!(true);
                        }
                        value.to_string()
                    })
                })
        });
    match value {
        Ok(Some(value)) => result.set(v8::String::new(scope, &value).unwrap().into()),
        Ok(None) => result.set_null(),
        Err(_) => {
            let error = crate::state::error(scope, "Module source is unavailable");
            scope.throw_exception(error);
        }
    }
}
