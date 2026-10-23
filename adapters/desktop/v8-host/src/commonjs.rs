use crate::state::{call, error, property, state};

pub fn load<'s>(scope: &mut v8::PinScope<'s, '_>, url: &str) -> Option<v8::Local<'s, v8::Value>> {
    let shared = state(scope);
    let cached = shared.borrow().commonjs.get(url).cloned();
    if let Some(cached) = cached {
        let module = v8::Local::new(scope, cached);
        return property(scope, module, "exports");
    }
    let definition = shared.borrow().definitions.get(url)?.clone();
    let source = definition["source"].as_str()?;
    let original_source = source;
    let exports: v8::Local<v8::Value> = if definition["format"] == "json" {
        let text = v8::String::new(scope, source)?;
        v8::json::parse(scope, text)?
    } else {
        v8::Object::new(scope).into()
    };
    let controller = v8::Local::new(scope, shared.borrow().controller.as_ref()?);
    let entry = shared.borrow().sources.as_ref()?.entry_url.clone();
    let name = v8::String::new(scope, url)?;
    let is_entry = v8::Boolean::new(scope, entry == url);
    let module = call(
        scope,
        controller,
        "createCommonJsModule",
        &[name.into(), is_entry.into(), exports],
    )?;
    let module = v8::Local::<v8::Object>::try_from(module).ok()?;
    shared
        .borrow_mut()
        .commonjs
        .insert(url.into(), v8::Global::new(scope, module));
    if definition["format"] == "json" {
        let key = v8::String::new(scope, "loaded")?;
        let loaded = v8::Boolean::new(scope, true);
        module.set(scope, key.into(), loaded.into())?;
        return Some(exports);
    }
    let outcome = (|| {
        let source = source
            .strip_prefix("#!")
            .and_then(|s| s.find('\n').map(|offset| &s[offset..]))
            .unwrap_or(source);
        let wrapper = v8::String::new(
            scope,
            &format!("(function(exports,require,module,__filename,__dirname){{\n{source}\n}})"),
        )?;
        let import_options = crate::plugin_graph::import_options(scope, url);
        let origin = v8::ScriptOrigin::new(
            scope,
            name.into(),
            -1,
            0,
            false,
            0,
            None,
            false,
            false,
            false,
            Some(import_options),
        );
        let script = v8::Script::compile(scope, wrapper, Some(&origin))?;
        // V8 cancels ScriptOrigin's -1 line offset when it has parsed a
        // sourceURL comment. The CommonJS wrapper still has one physical line.
        let has_source_url = script
            .get_unbound_script(scope)
            .get_source_url(scope)
            .is_string();
        crate::callback_diagnostic::register_origin(
            scope,
            script.script_id(),
            url,
            usize::from(has_source_url),
        );
        crate::observer::compiled(scope, url, original_source);
        let function = v8::Local::<v8::Function>::try_from(script.run(scope)?).ok()?;
        let load = v8::Function::builder(require_callback)
            .data(name.into())
            .build(scope)?;
        let resolve = v8::Function::builder(resolve_callback)
            .data(name.into())
            .build(scope)?;
        let main = shared.borrow().commonjs.get(&entry).cloned();
        let main = main
            .map(|module| v8::Local::new(scope, module).into())
            .unwrap_or_else(|| v8::undefined(scope).into());
        let require = call(
            scope,
            controller,
            "createCommonJsRequire",
            &[load.into(), resolve.into(), main],
        )?;
        let dirname = v8::String::new(
            scope,
            url.rsplit_once('/').map(|(dir, _)| dir).unwrap_or(url),
        )?;
        let execution = crate::observer::started(scope, url);
        let result = function.call(
            scope,
            exports,
            &[exports, require, module.into(), name.into(), dirname.into()],
        );
        crate::observer::finished(
            scope,
            execution,
            if result.is_some() {
                "completed"
            } else {
                "threw"
            },
        );
        result?;
        let key = v8::String::new(scope, "loaded")?;
        let loaded = v8::Boolean::new(scope, true);
        if module.set(scope, key.into(), loaded.into()) != Some(true) {
            if !scope.is_execution_terminating() {
                let message = v8::String::new(scope, "Cannot update CommonJS module state")?;
                let exception = v8::Exception::type_error(scope, message);
                scope.throw_exception(exception);
            }
            return None;
        }
        Some(())
    })();
    if outcome.is_none() {
        shared.borrow_mut().commonjs.remove(url);
        return None;
    }
    // Like Node, a later exports getter failure does not undo a module whose
    // body has already loaded successfully.
    property(scope, module, "exports")
}

fn require_error(scope: &mut v8::PinScope, message: &str, code: &str) {
    let exception = error(scope, message);
    let object = v8::Local::<v8::Object>::try_from(exception).unwrap();
    let key = v8::String::new(scope, "code").unwrap();
    let value = v8::String::new(scope, code).unwrap();
    object.create_data_property(scope, key.into(), value.into());
    scope.throw_exception(exception);
}

fn admitted_target(
    scope: &mut v8::PinScope,
    args: &v8::FunctionCallbackArguments,
) -> Option<String> {
    let Ok(specifier) = v8::Local::<v8::String>::try_from(args.get(0)) else {
        let message = v8::String::new(scope, "The module id must be a string")?;
        let exception = v8::Exception::type_error(scope, message);
        scope.throw_exception(exception);
        return None;
    };
    if specifier.utf8_length(scope) > 4096 {
        let exception = error(scope, "Require specifier exceeds the byte limit");
        scope.throw_exception(exception);
        return None;
    }
    let parent = args.data().to_rust_string_lossy(scope);
    let specifier = specifier.to_rust_string_lossy(scope);
    let target = state(scope)
        .borrow()
        .dependencies
        .get(&parent)
        .and_then(|deps| deps.get(&specifier))
        .cloned();
    if target.is_none() {
        require_error(
            scope,
            "Require target is outside the admitted plan",
            "ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED",
        );
    }
    target
}

fn resolve_callback(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut output: v8::ReturnValue,
) {
    if let Some(target) = admitted_target(scope, &args) {
        output.set(v8::String::new(scope, &target).unwrap().into());
    }
}

fn require_callback(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut output: v8::ReturnValue,
) {
    let shared = state(scope);
    let Some(target) = admitted_target(scope, &args) else {
        return;
    };
    let definition = shared.borrow().definitions.get(&target).cloned();
    let Some(definition) = definition else {
        // A resolve-only edge grants lookup, not execution or ambient I/O.
        require_error(
            scope,
            "Require target has no executable admitted plan",
            "ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED",
        );
        return;
    };
    let result = if definition["format"] == "synthetic" {
        (|| {
            let controller = v8::Local::new(scope, shared.borrow().controller.as_ref()?);
            let registry =
                v8::Local::<v8::Object>::try_from(property(scope, controller, "modules")?).ok()?;
            let binding =
                v8::Local::<v8::Object>::try_from(property(scope, registry, &target)?).ok()?;
            // Shared JavaScript bindings select the require value; ESM still reads namespace.
            property(scope, binding, "commonjsValue")
        })()
    } else if definition["format"] == "module" {
        require_error(
            scope,
            "Synchronous require of ES modules is unsupported",
            "ERR_REQUIRE_ESM",
        );
        None
    } else {
        load(scope, &target)
    };
    if let Some(value) = result {
        output.set(value);
    }
}
