//! One capability-free V8 isolate per helper process. Only verified plan edges
//! resolve static imports; dynamic imports, strings and Wasm generation deny.
use super::wire::InitRequest;
use crate::plugin_graph::prepare_observer_plan;
use std::{cell::RefCell, collections::HashMap, rc::Rc, time::Duration};

const HEAP_LIMIT_BYTES: usize = 32 * 1024 * 1024;
const PREPARE: &str = r#"(() => {
  const parse = JSON.parse;
  const freeze = Object.freeze;
  const keys = Object.keys;
  const create = Object.create;
  const resolve = Promise.resolve.bind(Promise);
  function deep(value) {
    let pending = { value, next: null };
    while (pending !== null) {
      const node = pending;
      pending = node.next;
      const item = node.value;
      if (item !== null && typeof item === 'object') {
        // Object.keys returns a fresh dense array for parsed JSON. Read only
        // its own numeric fields; user modules may replace Array iterators.
        const ownKeys = keys(item);
        const count = ownKeys.length;
        for (let index = 0; index < count; index += 1) {
          const key = ownKeys[index];
          pending = { value: item[key], next: pending };
        }
        freeze(item);
      }
    }
    return value;
  }
  return (eventText, configText) => {
    const event = deep(parse(eventText));
    const config = deep(parse(configText));
    let active = true;
    let used = false;
    const sink = create(null);
    sink.publish = (...args) => {
      if (!active || used || args.length !== 0) return;
      used = true;
    };
    freeze(sink);
    return freeze({
      invoke(callback) { return resolve(callback(event, config, sink)); },
      finish() { active = false; return used; }
    });
  };
})()"#;

struct Graph {
    modules: HashMap<String, v8::Global<v8::Module>>,
    dependencies: HashMap<String, HashMap<String, String>>,
}
type SharedGraph = Rc<RefCell<Graph>>;

fn resolve<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    attributes: v8::Local<'s, v8::FixedArray>,
    referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe scope, context);
    if attributes.length() != 0 {
        return None;
    }
    let graph = scope.get_slot::<SharedGraph>()?.clone();
    let graph = graph.borrow();
    let parent = graph.modules.iter().find_map(|(name, module)| {
        (v8::Local::new(scope, module) == referrer).then_some(name.as_str())
    })?;
    let requested = specifier.to_rust_string_lossy(scope);
    let target = graph.dependencies.get(parent)?.get(&requested)?;
    Some(v8::Local::new(scope, graph.modules.get(target)?))
}

fn deny_dynamic<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    _options: v8::Local<v8::Data>,
    _resource: v8::Local<v8::Value>,
    _specifier: v8::Local<v8::String>,
    _attributes: v8::Local<v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let resolver = v8::PromiseResolver::new(scope)?;
    let promise = resolver.get_promise(scope);
    let message = v8::String::new(scope, "Dynamic import denied")?;
    let error = v8::Exception::type_error(scope, message);
    resolver.reject(scope, error)?;
    Some(promise)
}

unsafe extern "C" fn deny_wasm(
    _context: v8::Local<v8::Context>,
    _source: v8::Local<v8::String>,
) -> bool {
    false
}

pub(super) struct Session {
    isolate: v8::OwnedIsolate,
    context: v8::Global<v8::Context>,
    prepare: v8::Global<v8::Function>,
    callback: v8::Global<v8::Function>,
    config: String,
}

impl Session {
    pub(super) fn new(init: &InitRequest) -> Option<Self> {
        if init.profile_id.is_empty()
            || init.profile_id.len() > 64
            || init.export_name.is_empty()
            || init.export_name.len() > 256
        {
            return None;
        }
        let plan = prepare_observer_plan(&init.plan, &init.bundle_sha256).ok()?;
        crate::driver::initialize_engine();
        let mut isolate =
            v8::Isolate::new(v8::CreateParams::default().heap_limits(0, HEAP_LIMIT_BYTES));
        isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
        isolate.set_host_import_module_dynamically_callback(deny_dynamic);
        isolate.set_allow_wasm_code_generation_callback(deny_wasm);
        let graph = Rc::new(RefCell::new(Graph {
            modules: HashMap::new(),
            dependencies: plan.dependencies,
        }));
        isolate.set_slot(graph.clone());
        let (context_global, prepare_global, callback_global) = {
            v8::scope!(let scope, &mut isolate);
            let context = v8::Context::new(scope, Default::default());
            let context_global = v8::Global::new(scope, context);
            let scope = &mut v8::ContextScope::new(scope, context);
            // Trusted preparation captures its intrinsics before user module initialization.
            let source = v8::String::new(scope, PREPARE)?;
            let script = v8::Script::compile(scope, source, None)?;
            let prepare = v8::Local::<v8::Function>::try_from(script.run(scope)?).ok()?;
            let prepare_global = v8::Global::new(scope, prepare);
            context.set_allow_generation_from_strings(false);
            for (url, definition) in &plan.definitions {
                let name = v8::String::new(scope, url)?;
                let text = v8::String::new(scope, definition["source"].as_str()?)?;
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
                    None,
                );
                let module = v8::script_compiler::compile_module(
                    scope,
                    &mut v8::script_compiler::Source::new(text, Some(&origin)),
                )?;
                graph
                    .borrow_mut()
                    .modules
                    .insert(url.clone(), v8::Global::new(scope, module));
            }
            let entry = v8::Local::new(scope, graph.borrow().modules.get(&plan.entry)?);
            v8::tc_scope!(let tc, scope);
            if entry.instantiate_module(tc, resolve) != Some(true) {
                return None;
            }
            let value = entry.evaluate(tc)?;
            let promise = v8::Local::<v8::Promise>::try_from(value).ok()?;
            promise.mark_as_handled();
            while promise.state() == v8::PromiseState::Pending {
                tc.perform_microtask_checkpoint();
                std::thread::sleep(Duration::from_millis(1));
            }
            if promise.state() != v8::PromiseState::Fulfilled {
                return None;
            }
            let namespace = v8::Local::<v8::Object>::try_from(entry.get_module_namespace()).ok()?;
            let export = v8::String::new(tc, &init.export_name)?;
            let callback =
                v8::Local::<v8::Function>::try_from(namespace.get(tc, export.into())?).ok()?;
            (
                context_global,
                prepare_global,
                v8::Global::new(tc, callback),
            )
        };
        Some(Self {
            isolate,
            context: context_global,
            prepare: prepare_global,
            callback: callback_global,
            config: init.config.to_string(),
        })
    }

    /// `on_prepared` emits the matching started ACK immediately before calling
    /// user code, after immutable copies and the token-bound sink exist.
    pub(super) fn call(
        &mut self,
        encoded_event: &str,
        on_prepared: impl FnOnce() -> bool,
    ) -> (bool, bool) {
        v8::scope!(let scope, &mut self.isolate);
        let context = v8::Local::new(scope, &self.context);
        let scope = &mut v8::ContextScope::new(scope, context);
        v8::tc_scope!(let tc, scope);
        let Some(event) = v8::String::new(tc, encoded_event) else {
            return (true, false);
        };
        let Some(config) = v8::String::new(tc, &self.config) else {
            return (true, false);
        };
        let prepare = v8::Local::new(tc, &self.prepare);
        let undefined = v8::undefined(tc);
        let Some(prepared) = prepare.call(tc, undefined.into(), &[event.into(), config.into()])
        else {
            return (true, false);
        };
        let Ok(prepared) = v8::Local::<v8::Object>::try_from(prepared) else {
            return (true, false);
        };
        let Some(invoke_key) = v8::String::new(tc, "invoke") else {
            return (true, false);
        };
        let Some(finish_key) = v8::String::new(tc, "finish") else {
            return (true, false);
        };
        let Some(invoke) = prepared
            .get(tc, invoke_key.into())
            .and_then(|v| v8::Local::<v8::Function>::try_from(v).ok())
        else {
            return (true, false);
        };
        let Some(finish) = prepared
            .get(tc, finish_key.into())
            .and_then(|v| v8::Local::<v8::Function>::try_from(v).ok())
        else {
            return (true, false);
        };
        if !on_prepared() {
            return (true, false);
        }
        let callback = v8::Local::new(tc, &self.callback);
        let result = invoke.call(tc, prepared.into(), &[callback.into()]);
        let failed = if let Some(value) = result {
            if let Ok(promise) = v8::Local::<v8::Promise>::try_from(value) {
                promise.mark_as_handled();
                while promise.state() == v8::PromiseState::Pending {
                    tc.perform_microtask_checkpoint();
                    std::thread::sleep(Duration::from_millis(1));
                }
                promise.state() != v8::PromiseState::Fulfilled
            } else {
                true
            }
        } else {
            true
        };
        let published = finish
            .call(tc, prepared.into(), &[])
            .is_some_and(|value| value.is_true());
        // No microtask admitted by one callback may survive into the next
        // token. Its sink is already inactive while this queue is drained.
        tc.perform_microtask_checkpoint();
        (failed, published && !failed)
    }
}
