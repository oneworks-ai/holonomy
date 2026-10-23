use crate::state::{PendingImport, error, property, state};
use serde_json::Value;

pub fn install_plan(scope: &mut v8::PinScope, source: &str) -> Result<String, String> {
    let plan: Value = serde_json::from_str(source).map_err(|_| "Invalid module plan")?;
    let entry = plan["entryUrl"]
        .as_str()
        .ok_or("Missing module entry")?
        .to_string();
    let shared = state(scope);
    let mut state = shared.borrow_mut();
    for module in plan["modules"]
        .as_array()
        .ok_or("Missing module definitions")?
    {
        let url = module["url"].as_str().ok_or("Invalid module identity")?;
        if !matches!(
            module["format"].as_str(),
            Some("module" | "commonjs" | "json" | "synthetic")
        ) {
            return Err("Unsupported module format".into());
        }
        if let Some(previous) = state.definitions.get(url)
            && previous != module
        {
            return Err("Module snapshot changed during a generation".into());
        }
        let mut dependencies = std::collections::HashMap::new();
        for dependency in module["dependencies"]
            .as_array()
            .ok_or("Invalid dependencies")?
        {
            if let (Some(specifier), Some(target)) = (
                dependency["specifier"].as_str(),
                dependency["resolvedUrl"].as_str(),
            ) {
                dependencies.insert(specifier.into(), target.into());
            }
        }
        state.dependencies.insert(url.into(), dependencies);
        state.definitions.insert(url.into(), module.clone());
    }
    Ok(entry)
}

fn identity(scope: &v8::PinScope, module: v8::Local<v8::Module>) -> Option<String> {
    state(scope)
        .borrow()
        .modules
        .iter()
        .find_map(|(name, global)| (v8::Local::new(scope, global) == module).then(|| name.clone()))
}

pub fn get<'s>(scope: &mut v8::PinScope<'s, '_>, url: &str) -> Option<v8::Local<'s, v8::Module>> {
    let shared = state(scope);
    if let Some(module) = shared.borrow().modules.get(url) {
        return Some(v8::Local::new(scope, module));
    }
    let definition = shared.borrow().definitions.get(url)?.clone();
    let name = v8::String::new(scope, url)?;
    let module = if definition["format"] != "module" {
        let names = definition["exportNames"]
            .as_array()?
            .iter()
            .map(|name| v8::String::new(scope, name.as_str()?))
            .collect::<Option<Vec<_>>>()?;
        v8::Module::create_synthetic_module(scope, name, &names, evaluate_synthetic)
    } else {
        let source = v8::String::new(scope, definition["source"].as_str()?)?;
        let options = Some(crate::plugin_graph::import_options(scope, url));
        let origin = v8::ScriptOrigin::new(
            scope,
            name.into(),
            0,
            0,
            false,
            0,
            None,
            false,
            false,
            true,
            options,
        );
        let compiled = v8::script_compiler::compile_module(
            scope,
            &mut v8::script_compiler::Source::new(source, Some(&origin)),
        )?;
        if let Some(script_id) = compiled.script_id() {
            crate::callback_diagnostic::register_origin(scope, script_id, url, 0);
        }
        crate::observer::compiled(scope, url, definition["source"].as_str()?);
        compiled
    };
    shared
        .borrow_mut()
        .modules
        .insert(url.into(), v8::Global::new(scope, module));
    Some(module)
}

pub fn resolve<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    attributes: v8::Local<'s, v8::FixedArray>,
    referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    // V8 owns these callback handles and guarantees the current isolate.
    v8::callback_scope!(unsafe scope, context);
    if attributes.length() != 0 {
        let e = error(scope, "Import attributes are unsupported");
        scope.throw_exception(e);
        return None;
    }
    let parent = identity(scope, referrer)?;
    let specifier = specifier.to_rust_string_lossy(scope);
    let target = state(scope)
        .borrow()
        .dependencies
        .get(&parent)?
        .get(&specifier)?
        .clone();
    get(scope, &target)
}

fn evaluate_synthetic<'s>(
    context: v8::Local<'s, v8::Context>,
    module: v8::Local<v8::Module>,
) -> Option<v8::Local<'s, v8::Value>> {
    v8::callback_scope!(unsafe scope, context);
    let name = identity(scope, module)?;
    let shared = state(scope);
    let controller = v8::Local::new(scope, shared.borrow().controller.as_ref()?);
    let definition = shared.borrow().definitions.get(&name)?.clone();
    let namespace = if definition["format"] == "synthetic" {
        let registry =
            v8::Local::<v8::Object>::try_from(property(scope, controller, "modules")?).ok()?;
        let binding = v8::Local::<v8::Object>::try_from(property(scope, registry, &name)?).ok()?;
        property(scope, binding, "namespace")?
    } else {
        crate::commonjs::load(scope, &name)?
    };
    for name in definition["exportNames"].as_array()? {
        let value = if name == "default" && definition["format"] != "synthetic" {
            namespace
        } else if let Ok(object) = v8::Local::<v8::Object>::try_from(namespace) {
            property(scope, object, name.as_str()?)?
        } else {
            v8::undefined(scope).into()
        };
        let key = v8::String::new(scope, name.as_str()?)?;
        module.set_synthetic_module_export(scope, key, value)?;
    }
    let resolver = v8::PromiseResolver::new(scope)?;
    let undefined = v8::undefined(scope);
    resolver.resolve(scope, undefined.into())?;
    Some(resolver.get_promise(scope).into())
}

pub fn evaluate<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    module: v8::Local<v8::Module>,
) -> Option<(
    v8::Local<'s, v8::Promise>,
    Option<crate::observer::Execution>,
)> {
    if module.get_status() == v8::ModuleStatus::Uninstantiated
        && module.instantiate_module(scope, resolve) != Some(true)
    {
        return None;
    }
    if module.get_status() == v8::ModuleStatus::Errored {
        scope.throw_exception(module.get_exception());
        return None;
    }
    let execution = if module.get_status() == v8::ModuleStatus::Instantiated {
        identity(scope, module).and_then(|url| crate::observer::started(scope, &url))
    } else {
        None
    };
    let value = match module.evaluate(scope) {
        Some(value) => value,
        None => {
            crate::observer::finished(scope, execution, "threw");
            return None;
        }
    };
    let promise = v8::Local::<v8::Promise>::try_from(value).ok()?;
    crate::rejection::handle(scope, promise);
    Some((promise, execution))
}

pub fn import_dynamic<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    options: v8::Local<v8::Data>,
    _resource: v8::Local<v8::Value>,
    specifier: v8::Local<v8::String>,
    attributes: v8::Local<v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let resolver = v8::PromiseResolver::new(scope)?;
    let promise = resolver.get_promise(scope);
    if specifier.utf8_length(scope) > 4096 {
        let exception = error(scope, "Dynamic import request limit");
        resolver.reject(scope, exception)?;
        return Some(promise);
    }
    let Some(lease) = crate::state::ImportLease::acquire(&state(scope).borrow().import_count)
    else {
        let exception = error(scope, "Dynamic import pending limit");
        resolver.reject(scope, exception)?;
        return Some(promise);
    };
    let requested = specifier.to_rust_string_lossy(scope);
    let in_control_context = {
        let shared = state(scope);
        let state = shared.borrow();
        state.control.as_ref().is_some_and(|control| {
            control.context.as_ref().is_some_and(|context| {
                v8::Local::new(scope, context) == scope.get_current_context()
            })
        })
    };
    if in_control_context {
        let selected = if attributes.length() == 0 {
            crate::plugin_graph::import_owner(scope, options).and_then(|parent| {
                crate::plugin_graph::import_target(
                    &mut state(scope).borrow_mut(),
                    &parent,
                    &requested,
                )
            })
        } else {
            None
        };
        let Some((target, graph_id)) = selected else {
            let exception = error(
                scope,
                "Native plugin import is not admitted in its source graph",
            );
            resolver.reject(scope, exception)?;
            return Some(promise);
        };
        let (module, evaluation) = {
            v8::tc_scope!(let tc, scope);
            let evaluated = (|| {
                let module = get(tc, &target)?;
                let (evaluation, _) = evaluate(tc, module)?;
                Some((v8::Global::new(tc, module), v8::Global::new(tc, evaluation)))
            })();
            match evaluated {
                Some(value) => value,
                None => {
                    let exception = tc
                        .exception()
                        .unwrap_or_else(|| error(tc, "Native plugin evaluation failed"));
                    tc.reset();
                    crate::plugin_graph::finish_import(&mut state(tc).borrow_mut(), &graph_id);
                    resolver.reject(tc, exception)?;
                    return Some(promise);
                }
            }
        };
        state(scope).borrow_mut().imports.push(PendingImport {
            _lease: lease,
            module_gate: None,
            approved: false,
            context: v8::Global::new(scope, scope.get_current_context()),
            plugin_graph: Some(graph_id),
            resolver: v8::Global::new(scope, resolver),
            planning: None,
            evaluation: Some(evaluation),
            execution: None,
            module: Some(module),
        });
        return Some(promise);
    }
    if state(scope)
        .borrow()
        .remote
        .as_ref()
        .is_some_and(|remote| !remote.module_import_enabled())
        || state(scope).borrow().control.is_some()
    {
        let e = error(scope, "Dynamic import is denied by the configured Policy");
        resolver.reject(scope, e)?;
        return Some(promise);
    }
    if attributes.length() != 0 {
        let e = error(scope, "Import attributes are unsupported");
        resolver.reject(scope, e)?;
        return Some(promise);
    }
    let Some(parent) = crate::plugin_graph::import_owner(scope, options)
        .filter(|parent| state(scope).borrow().definitions.contains_key(parent))
    else {
        let exception = error(scope, "Dynamic import caller provenance is unavailable");
        resolver.reject(scope, exception)?;
        return Some(promise);
    };
    let Some(planning) = crate::module_planner::plan(scope, &requested, &parent) else {
        let exception = error(scope, "Dynamic module planning failed");
        resolver.reject(scope, exception)?;
        return Some(promise);
    };
    let shared = state(scope);
    shared.borrow_mut().imports.push(PendingImport {
        _lease: lease,
        module_gate: None,
        approved: false,
        context: v8::Global::new(scope, scope.get_current_context()),
        plugin_graph: None,
        resolver: v8::Global::new(scope, resolver),
        planning: Some(planning),
        evaluation: None,
        execution: None,
        module: None,
    });
    Some(promise)
}

pub fn pump_imports(scope: &mut v8::PinScope) -> Option<bool> {
    let shared = state(scope);
    let mut progressed = false;
    let pending = std::mem::take(&mut shared.borrow_mut().imports);
    for mut item in pending {
        let context = v8::Local::new(scope, &item.context);
        let scope = &mut v8::ContextScope::new(scope, context);
        let resolver = v8::Local::new(scope, &item.resolver);
        if let Some(gate) = item.module_gate.as_mut() {
            match gate.poll() {
                None => {
                    shared.borrow_mut().imports.push(item);
                    continue;
                }
                Some(false) => {
                    let exception = error(scope, "Dynamic import was denied");
                    resolver.reject(scope, exception)?;
                    progressed = true;
                    continue;
                }
                Some(true) => {
                    item.approved = true;
                    item.module_gate = None;
                }
            }
        }
        if let Some(planning) = &item.planning {
            let planning = v8::Local::new(scope, planning);
            match planning.state() {
                v8::PromiseState::Pending => {
                    shared.borrow_mut().imports.push(item);
                    continue;
                }
                v8::PromiseState::Rejected => {
                    progressed = true;
                    let exception = crate::module_planner::rejection(scope, planning);
                    resolver.reject(scope, exception)?;
                    continue;
                }
                v8::PromiseState::Fulfilled => {
                    progressed = true;
                    let text = planning.result(scope).to_rust_string_lossy(scope);
                    if !item.approved && shared.borrow().remote.is_some() {
                        let decision = start_module_gate(scope, &text);
                        if let Some(decision) = decision {
                            item.module_gate = Some(decision);
                            shared.borrow_mut().imports.push(item);
                        } else {
                            let exception = error(scope, "Dynamic import was denied");
                            resolver.reject(scope, exception)?;
                        }
                        continue;
                    }
                    v8::tc_scope!(let tc, scope);
                    let evaluation = (|| {
                        let entry = match install_plan(tc, &text) {
                            Ok(entry) => entry,
                            Err(message) => {
                                let e = error(tc, &message);
                                tc.throw_exception(e);
                                return None;
                            }
                        };
                        let module = get(tc, &entry)?;
                        let (evaluation, execution) = evaluate(tc, module)?;
                        item.execution = execution;
                        item.module = Some(v8::Global::new(tc, module));
                        Some(v8::Global::new(tc, evaluation))
                    })();
                    if evaluation.is_none() {
                        let exception = tc
                            .exception()
                            .unwrap_or_else(|| error(tc, "Dynamic import failed"));
                        tc.reset();
                        resolver.reject(tc, exception)?;
                        continue;
                    }
                    item.evaluation = evaluation;
                    item.planning = None;
                }
            }
        }
        let evaluation = v8::Local::new(scope, item.evaluation.as_ref()?);
        match evaluation.state() {
            v8::PromiseState::Pending => shared.borrow_mut().imports.push(item),
            v8::PromiseState::Rejected => {
                progressed = true;
                crate::observer::finished(scope, item.execution.take(), "threw");
                resolver.reject(scope, evaluation.result(scope))?;
                if let Some(graph) = &item.plugin_graph {
                    crate::plugin_graph::finish_import(&mut shared.borrow_mut(), graph);
                }
            }
            v8::PromiseState::Fulfilled => {
                progressed = true;
                crate::observer::finished(scope, item.execution.take(), "completed");
                let module = v8::Local::new(scope, item.module.as_ref()?);
                resolver.resolve(scope, module.get_module_namespace())?;
                if let Some(graph) = &item.plugin_graph {
                    crate::plugin_graph::finish_import(&mut shared.borrow_mut(), graph);
                }
            }
        }
    }
    Some(progressed)
}

fn start_module_gate(
    scope: &mut v8::PinScope,
    encoded: &str,
) -> Option<crate::control::ModuleGateDecision> {
    // The entire plan is produced by the private planner, never Guest JSON.
    let plan: Value = serde_json::from_str(encoded).ok()?;
    let origin = plan["entryUrl"].as_str()?;
    let module = plan["modules"]
        .as_array()?
        .iter()
        .find(|module| module["url"] == origin)?;
    let shared = state(scope);
    let id = shared.borrow_mut().engine_gate.next_request_id()?;
    let mut request = serde_json::json!({"codeKind":"module", "requestId":id, "origin":origin, "sourceAvailable":false});
    let reader_max_bytes = shared.borrow().remote.as_ref()?.source_reader_max_bytes();
    let mut source_prefix = None;
    if let Some(source) = module["source"].as_str() {
        use sha2::{Digest, Sha256};
        request["sourceAvailable"] = Value::Bool(true);
        request["sourceBytes"] = Value::from(source.len());
        request["sourceSha256"] = Value::String(format!("{:x}", Sha256::digest(source.as_bytes())));
        if reader_max_bytes > 0 {
            source_prefix = Some(zeroize::Zeroizing::new(
                source.as_bytes()[..source.len().min(reader_max_bytes)].to_vec(),
            ));
        }
    } else if module["format"] != "synthetic" {
        return None;
    }
    shared
        .borrow()
        .remote
        .as_ref()?
        .start_module_gate(id, request.to_string(), source_prefix)
}

pub extern "C" fn import_meta(
    context: v8::Local<v8::Context>,
    module: v8::Local<v8::Module>,
    meta: v8::Local<v8::Object>,
) {
    v8::callback_scope!(unsafe scope, context);
    if let Some(name) = identity(scope, module) {
        let key = v8::String::new(scope, "url").unwrap();
        let value = v8::String::new(scope, &name).unwrap();
        meta.create_data_property(scope, key.into(), value.into());
    }
}
