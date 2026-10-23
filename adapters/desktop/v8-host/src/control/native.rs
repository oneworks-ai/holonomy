use crate::state::{error, state};
use holonomy_desktop_host::SourceReadPurpose;
const BOOTSTRAP: &str = include_str!("../../generated/control.js");
#[cfg(feature = "v86-backend")]
const V86_OPERATION: i32 = 17;
#[cfg(all(target_os = "macos", feature = "v86-backend"))]
const DARWIN_PROCESS_OPERATION: i32 = 18;
#[cfg(all(target_os = "macos", not(feature = "v86-backend")))]
const DARWIN_PROCESS_OPERATION: i32 = 17;
const DEVICE_OPERATION: i32 =
    17 + cfg!(feature = "v86-backend") as i32 + cfg!(target_os = "macos") as i32;
const OBSERVER_PROFILE_SOURCE_OPERATION: i32 = DEVICE_OPERATION + 1;
const OBSERVER_PROFILE_START_OPERATION: i32 = DEVICE_OPERATION + 2;
const OBSERVER_PROFILE_STATUS_OPERATION: i32 = DEVICE_OPERATION + 3;
const OBSERVER_PROFILE_PUBLISH_OPERATION: i32 = DEVICE_OPERATION + 4;
const OBSERVER_PROFILES_CLOSE_OPERATION: i32 = DEVICE_OPERATION + 5;
const PLUGIN_SOURCE_RESOURCE_OPERATION: i32 = OBSERVER_PROFILES_CLOSE_OPERATION + 1;
#[cfg(feature = "v86-backend")]
const PROCESS_NETWORK_SYNC_OPERATION: i32 = PLUGIN_SOURCE_RESOURCE_OPERATION + 1;
#[cfg(feature = "v86-backend")]
const PROCESS_NETWORK_START_OPERATION: i32 = PLUGIN_SOURCE_RESOURCE_OPERATION + 2;
#[cfg(feature = "v86-backend")]
const PROCESS_NETWORK_CANCEL_OPERATION: i32 = PLUGIN_SOURCE_RESOURCE_OPERATION + 3;
const MAX_OBSERVER_PLAN_BYTES: usize = 32 * 1024 * 1024;

pub fn initialize(scope: &mut v8::PinScope) -> Option<()> {
    if state(scope).borrow().control.is_none() {
        return Some(());
    }
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    context.set_allow_generation_from_strings(false);
    let host = v8::Object::new(scope);
    for (index, name) in [
        "configuration",
        "filesystem",
        "schedule",
        "clear",
        "networkSync",
        "networkStart",
        "networkCancel",
        "now",
        "pluginSource",
        "pluginPlan",
        "pluginGraphRelease",
        "observerDiagnostic",
        "scheduleUnreferenced",
        "sourceReadAudit",
        "storageStart",
        "storageCancel",
        "storageReady",
        #[cfg(feature = "v86-backend")]
        "v86",
        #[cfg(target_os = "macos")]
        "darwinProcess",
        "device",
        "observerProfileSource",
        "observerProfileStart",
        "observerProfileStatus",
        "observerProfilePublish",
        "observerProfilesClose",
        "pluginSourceResource",
        #[cfg(feature = "v86-backend")]
        "processNetworkSync",
        #[cfg(feature = "v86-backend")]
        "processNetworkStart",
        #[cfg(feature = "v86-backend")]
        "processNetworkCancel",
    ]
    .iter()
    .enumerate()
    {
        let data = v8::Integer::new(scope, index as i32);
        let function = v8::Function::builder(dispatch)
            .data(data.into())
            .build(scope)?;
        let key = v8::String::new(scope, name)?;
        host.set(scope, key.into(), function.into())?;
    }
    let global = context.global(scope);
    let key = v8::String::new(scope, "__holoControlHost")?;
    global.set(scope, key.into(), host.into())?;
    let source = v8::String::new(scope, BOOTSTRAP)?;
    let name = v8::String::new(scope, "holonomy:///runtime/native-control.js")?;
    let import_options =
        crate::plugin_graph::import_options(scope, crate::plugin_graph::BOOTSTRAP_OWNER);
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
        false,
        Some(import_options),
    );
    let script = v8::Script::compile(scope, source, Some(&origin))?;
    let api = v8::Local::<v8::Object>::try_from(script.run(scope)?).ok()?;
    let shared = state(scope);
    let mut state = shared.borrow_mut();
    let control = state.control.as_mut()?;
    control.context = Some(v8::Global::new(scope, context));
    control.api = Some(v8::Global::new(scope, api));
    Some(())
}

fn dispatch(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut output: v8::ReturnValue,
) {
    let shared = state(scope);
    let index = args.data().int32_value(scope).unwrap_or(-1);
    match index {
        0 => {
            let text = shared
                .borrow()
                .control
                .as_ref()
                .map(|c| c.configuration.clone());
            if let Some(text) = text {
                output.set(v8::String::new(scope, &text).unwrap().into());
            }
        }
        1 => {
            if !args.get(0).is_string() {
                let e = error(scope, "Invalid native Provider request");
                scope.throw_exception(e);
                return;
            }
            let text = args.get(0).to_rust_string_lossy(scope);
            let result = shared
                .borrow_mut()
                .control
                .as_mut()
                .map(|c| c.filesystem.dispatch(&text));
            if let Some(result) = result {
                output.set(v8::String::new(scope, &result).unwrap().into());
            }
        }
        2 | 12 => {
            let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
                return;
            };
            let delay = args.get(1).number_value(scope).unwrap_or(0.0);
            if !delay.is_finite() || !(0.0..=120000.0).contains(&delay) {
                let e = error(scope, "Invalid Host deadline");
                scope.throw_exception(e);
                return;
            }
            let now = shared.borrow().start.elapsed().as_secs_f64() * 1000.0;
            let mut state = shared.borrow_mut();
            let Some(control) = state.control.as_mut() else {
                return;
            };
            if control.timers.len() >= 4096 || control.next_timer == u32::MAX {
                drop(state);
                let e = error(scope, "Host timer limit");
                scope.throw_exception(e);
                return;
            }
            control.next_timer += 1;
            let id = control.next_timer;
            control.timers.insert(
                id,
                (now + delay, v8::Global::new(scope, callback), index == 2),
            );
            output.set_uint32(id);
        }
        3 => {
            let id = args.get(0).uint32_value(scope).unwrap_or(0);
            if let Some(control) = shared.borrow_mut().control.as_mut() {
                control.timers.remove(&id);
            }
        }
        4..=7 => crate::network_io::dispatch(scope, args, output, index),
        14 | 15 => crate::storage_io::dispatch(scope, args, output, index == 15),
        16 => {
            let ready = shared
                .borrow()
                .control
                .as_ref()
                .and_then(|control| control.storage.as_ref())
                .is_some_and(crate::storage_io::StorageIo::available);
            output.set_bool(ready);
        }
        8 => {
            if !args.get(0).is_string() {
                let exception = error(scope, "Invalid native plugin source request");
                scope.throw_exception(exception);
                return;
            }
            let url = args.get(0).to_rust_string_lossy(scope);
            let purpose = if args.length() < 2 || args.get(1).is_undefined() {
                SourceReadPurpose::Module
            } else {
                let Ok(value) = v8::Local::<v8::String>::try_from(args.get(1)) else {
                    let exception = error(scope, "Invalid native plugin source purpose");
                    scope.throw_exception(exception);
                    return;
                };
                match SourceReadPurpose::parse(&value.to_rust_string_lossy(scope)) {
                    Ok(purpose) => purpose,
                    Err(_) => {
                        let exception = error(scope, "Invalid native plugin source purpose");
                        scope.throw_exception(exception);
                        return;
                    }
                }
            };
            match shared
                .borrow_mut()
                .control
                .as_mut()
                .ok_or(())
                .and_then(|control| {
                    control
                        .plugins
                        .read_with_purpose(&url, purpose)
                        .map_err(|_| ())
                }) {
                Ok(Some(source)) => output.set(v8::String::new(scope, &source).unwrap().into()),
                Ok(None) => output.set(v8::null(scope).into()),
                Err(()) => {
                    let exception = error(scope, "Native plugin source is unavailable");
                    scope.throw_exception(exception);
                }
            }
        }
        PLUGIN_SOURCE_RESOURCE_OPERATION => {
            let Ok(requested) = v8::Local::<v8::String>::try_from(args.get(0)) else {
                let exception = error(scope, "Invalid native plugin resource request");
                scope.throw_exception(exception);
                return;
            };
            if requested.utf8_length(scope) > 4096 {
                let exception = error(scope, "Native plugin resource request exceeds bounds");
                scope.throw_exception(exception);
                return;
            }
            let url = requested.to_rust_string_lossy(scope);
            let purpose = if args.length() < 2 || args.get(1).is_undefined() {
                SourceReadPurpose::Module
            } else {
                let Ok(value) = v8::Local::<v8::String>::try_from(args.get(1)) else {
                    let exception = error(scope, "Invalid native plugin resource purpose");
                    scope.throw_exception(exception);
                    return;
                };
                match SourceReadPurpose::parse(&value.to_rust_string_lossy(scope)) {
                    Ok(purpose) => purpose,
                    Err(_) => {
                        let exception = error(scope, "Invalid native plugin resource purpose");
                        scope.throw_exception(exception);
                        return;
                    }
                }
            };
            match shared
                .borrow_mut()
                .control
                .as_mut()
                .ok_or(())
                .and_then(|control| {
                    control
                        .plugins
                        .read_resource_with_purpose(&url, purpose)
                        .map_err(|_| ())
                }) {
                Ok(Some(resource)) => output.set(v8::String::new(scope, &resource).unwrap().into()),
                Ok(None) => output.set(v8::null(scope).into()),
                Err(()) => {
                    let exception = error(scope, "Native plugin resource is unavailable");
                    scope.throw_exception(exception);
                }
            }
        }
        9 => {
            if !args.get(0).is_string() || !args.get(1).is_string() {
                let exception = error(scope, "Invalid native plugin module plan");
                scope.throw_exception(exception);
                return;
            }
            if v8::Local::<v8::String>::try_from(args.get(0))
                .unwrap()
                .utf8_length(scope)
                > holonomy_desktop_host::MAX_GRAPH_BYTES * 8
                || v8::Local::<v8::String>::try_from(args.get(1))
                    .unwrap()
                    .utf8_length(scope)
                    != 64
            {
                let exception = error(scope, "Native plugin plan exceeds bounds");
                scope.throw_exception(exception);
                return;
            }
            let plan = args.get(0).to_rust_string_lossy(scope);
            let digest = args.get(1).to_rust_string_lossy(scope);
            match crate::plugin_graph::install(scope, &plan, &digest) {
                Ok(entry) => output.set(v8::String::new(scope, &entry).unwrap().into()),
                Err(message) => {
                    let exception = error(scope, &message);
                    scope.throw_exception(exception);
                }
            }
        }
        10 => {
            if !args.get(0).is_string() {
                let exception = error(scope, "Invalid native plugin graph release");
                scope.throw_exception(exception);
                return;
            }
            let entry = args.get(0).to_rust_string_lossy(scope);
            crate::plugin_graph::release(&mut shared.borrow_mut(), &entry);
        }
        11 => {
            let kind = args.get(0).to_rust_string_lossy(scope);
            let event = args.get(1).to_rust_string_lossy(scope);
            if matches!(
                kind.as_str(),
                "callback.failed" | "callback.timeout" | "event.dropped"
            ) && matches!(
                event.as_str(),
                "gc.completed"
                    | "memory.pressure"
                    | "promise.rejected"
                    | "runtime.exception"
                    | "runtime.terminated"
                    | "script.compiled"
                    | "script.execution-finished"
                    | "script.execution-started"
                    | "observer.overflow"
            ) {
                eprintln!("holo observer {kind} {event}");
            }
        }
        13 => {
            let Ok(value) = v8::Local::<v8::String>::try_from(args.get(0)) else {
                output.set_bool(false);
                return;
            };
            if value.utf8_length(scope) > 1024 {
                output.set_bool(false);
                return;
            }
            let encoded = value.to_rust_string_lossy(scope);
            let recorded = shared
                .borrow_mut()
                .control
                .as_mut()
                .and_then(|control| control.diagnostic_audit.as_mut())
                .is_some_and(|audit| audit.record_source_read(&encoded));
            output.set_bool(recorded);
        }
        #[cfg(feature = "v86-backend")]
        V86_OPERATION => {
            let Ok(value) = v8::Local::<v8::String>::try_from(args.get(0)) else {
                let exception = error(scope, "Invalid Host VM command");
                scope.throw_exception(exception);
                return;
            };
            if value.utf8_length(scope) > super::v86::MAX_COMMAND_BYTES {
                let exception = error(scope, "Host VM command exceeds bounds");
                scope.throw_exception(exception);
                return;
            }
            let encoded = value.to_rust_string_lossy(scope);
            let result = shared.borrow_mut().control.as_mut().map(|control| {
                control
                    .vm
                    .command_cancelled(&encoded, || scope.is_execution_terminating())
            });
            if let Some(result) = result {
                output.set(v8::String::new(scope, &result).unwrap().into());
            }
        }
        #[cfg(target_os = "macos")]
        DARWIN_PROCESS_OPERATION => {
            let Ok(value) = v8::Local::<v8::String>::try_from(args.get(0)) else {
                let exception = error(scope, "Invalid private Process command");
                scope.throw_exception(exception);
                return;
            };
            if value.utf8_length(scope) > 24 * 1024 * 1024 {
                let exception = error(scope, "Private Process command exceeds bounds");
                scope.throw_exception(exception);
                return;
            }
            let encoded = value.to_rust_string_lossy(scope);
            let mut state = shared.borrow_mut();
            let Some(control) = state.control.as_mut() else {
                return;
            };
            if control.process_io.is_none() {
                control.process_io =
                    holonomy_desktop_host::darwin_process::ProcessIoClient::new().ok();
            }
            let result = control
                .process_io
                .as_mut()
                .map(|client| {
                    client.command_cancelled(&encoded, || scope.is_execution_terminating())
                })
                .unwrap_or_else(|| {
                    serde_json::json!({"schemaVersion":1,"ok":false,"code":"unavailable"})
                        .to_string()
                });
            if let Some(value) = v8::String::new(scope, &result) {
                output.set(value.into());
            }
        }
        DEVICE_OPERATION => {
            let Ok(value) = v8::Local::<v8::String>::try_from(args.get(0)) else {
                let exception = error(scope, "Invalid private Device command");
                scope.throw_exception(exception);
                return;
            };
            if value.utf8_length(scope) > 16 * 1024 {
                let exception = error(scope, "Private Device command exceeds bounds");
                scope.throw_exception(exception);
                return;
            }
            let encoded = value.to_rust_string_lossy(scope);
            let now = shared.borrow().start.elapsed().as_secs_f64() * 1000.0;
            let result = shared
                .borrow_mut()
                .control
                .as_mut()
                .map(|control| control.device.command(&encoded, now));
            if let Some(result) = result
                && let Some(value) = v8::String::new(scope, &result)
            {
                output.set(value.into());
            }
        }
        OBSERVER_PROFILE_SOURCE_OPERATION => {
            let (Ok(id), Ok(url)) = (
                v8::Local::<v8::String>::try_from(args.get(0)),
                v8::Local::<v8::String>::try_from(args.get(1)),
            ) else {
                let exception = error(scope, "Invalid Observer profile source request");
                scope.throw_exception(exception);
                return;
            };
            if id.utf8_length(scope) > 64 || url.utf8_length(scope) > 4096 {
                let exception = error(scope, "Observer profile source request exceeds bounds");
                scope.throw_exception(exception);
                return;
            }
            let id = id.to_rust_string_lossy(scope);
            let url = url.to_rust_string_lossy(scope);
            let result = shared
                .borrow_mut()
                .control
                .as_mut()
                .ok_or(())
                .and_then(|control| {
                    let profile = control.observer_profiles.get(&id).ok_or(())?;
                    if profile.module.instance_id != format!("observer.{id}")
                        || profile.module.root_url != format!("holo-plugins:///observer.{id}/")
                        || !url.starts_with(&profile.module.root_url)
                    {
                        return Err(());
                    }
                    control
                        .observer_sources
                        .read_with_limit(&url, 1024 * 1024)
                        .map_err(|_| ())
                });
            match result {
                Ok(Some(source)) => output.set(v8::String::new(scope, &source).unwrap().into()),
                Ok(None) => output.set(v8::null(scope).into()),
                Err(()) => {
                    let exception = error(scope, "Observer profile source is unavailable");
                    scope.throw_exception(exception);
                }
            }
        }
        OBSERVER_PROFILE_START_OPERATION => {
            let (Ok(id), Ok(plan), Ok(digest)) = (
                v8::Local::<v8::String>::try_from(args.get(0)),
                v8::Local::<v8::String>::try_from(args.get(1)),
                v8::Local::<v8::String>::try_from(args.get(2)),
            ) else {
                output.set_bool(false);
                return;
            };
            if id.utf8_length(scope) > 64
                || plan.utf8_length(scope) > MAX_OBSERVER_PLAN_BYTES
                || digest.utf8_length(scope) != 64
            {
                output.set_bool(false);
                return;
            }
            let id = id.to_rust_string_lossy(scope);
            let plan = plan.to_rust_string_lossy(scope);
            let digest = digest.to_rust_string_lossy(scope);
            let timeout = args.get(3).uint32_value(scope).unwrap_or(0) as u64;
            let queue = args.get(4).uint32_value(scope).unwrap_or(0) as usize;
            let accepted = (1..=1000).contains(&timeout)
                && (1..=256).contains(&queue)
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                && serde_json::from_str::<serde_json::Value>(&plan).is_ok_and(|value| {
                    let mut control = shared.borrow_mut();
                    let Some(control) = control.control.as_mut() else {
                        return false;
                    };
                    let Some(profile) = control.observer_profiles.get(&id) else {
                        return false;
                    };
                    if value.get("entryUrl").and_then(serde_json::Value::as_str)
                        != Some(profile.module.entry_url.as_str())
                        || value.get("rootUrl").and_then(serde_json::Value::as_str)
                            != Some(profile.module.root_url.as_str())
                        || profile
                            .module
                            .integrity
                            .as_deref()
                            .is_some_and(|pin| pin != digest)
                    {
                        return false;
                    }
                    let Some(sink) = control
                        .observer_sinks
                        .get(&id)
                        .filter(|sink| sink.available())
                    else {
                        return false;
                    };
                    control
                        .observer_executor
                        .start(crate::observer_executor::ObserverExecutorSpec {
                            profile_id: id.clone(),
                            plan: plan.clone(),
                            bundle_sha256: digest.clone(),
                            export_name: profile.module.export_name.clone(),
                            config: profile.module.config.clone(),
                            callback_timeout_ms: timeout,
                            max_queued_events: queue,
                            sink: sink.clone(),
                        })
                        .is_ok()
                });
            output.set_bool(accepted);
        }
        OBSERVER_PROFILE_STATUS_OPERATION => {
            let Ok(id) = v8::Local::<v8::String>::try_from(args.get(0)) else {
                output.set(v8::String::new(scope, "failed").unwrap().into());
                return;
            };
            if id.utf8_length(scope) > 64 {
                output.set(v8::String::new(scope, "failed").unwrap().into());
                return;
            }
            let id = id.to_rust_string_lossy(scope);
            let status = shared
                .borrow()
                .control
                .as_ref()
                .filter(|control| control.observer_profiles.contains_key(&id))
                .map(|control| control.observer_executor.status(&id))
                .unwrap_or("failed");
            output.set(v8::String::new(scope, status).unwrap().into());
        }
        OBSERVER_PROFILE_PUBLISH_OPERATION => {
            let (Ok(id), Ok(event)) = (
                v8::Local::<v8::String>::try_from(args.get(0)),
                v8::Local::<v8::String>::try_from(args.get(1)),
            ) else {
                output.set_bool(false);
                return;
            };
            if id.utf8_length(scope) > 64 || event.utf8_length(scope) > 8 * 1024 {
                output.set_bool(false);
                return;
            }
            let id = id.to_rust_string_lossy(scope);
            let event = event.to_rust_string_lossy(scope);
            let published = shared
                .borrow()
                .control
                .as_ref()
                .filter(|control| control.observer_profiles.contains_key(&id))
                .is_some_and(|control| control.observer_executor.try_publish(&id, &event));
            output.set_bool(published);
        }
        OBSERVER_PROFILES_CLOSE_OPERATION => {
            if let Some(control) = shared.borrow_mut().control.as_mut() {
                control.observer_executor.close();
                for sink in control.observer_sinks.values() {
                    sink.close();
                }
            }
            output.set_bool(true);
        }
        #[cfg(feature = "v86-backend")]
        PROCESS_NETWORK_SYNC_OPERATION => {
            crate::process_network_io::dispatch(scope, args, output, 0)
        }
        #[cfg(feature = "v86-backend")]
        PROCESS_NETWORK_START_OPERATION => {
            crate::process_network_io::dispatch(scope, args, output, 1)
        }
        #[cfg(feature = "v86-backend")]
        PROCESS_NETWORK_CANCEL_OPERATION => {
            crate::process_network_io::dispatch(scope, args, output, 2)
        }
        _ => {}
    }
}

#[cfg(test)]
mod device_tests {
    use super::*;
    use crate::{
        control::ControlState,
        state::{HostState, SharedState},
    };
    use holonomy_desktop_host::HostConfiguration;
    use std::{cell::RefCell, rc::Rc, time::Instant};

    #[test]
    fn private_device_callback_rechecks_policy_and_close_inside_host_isolate() {
        crate::driver::initialize_engine();
        let configuration: HostConfiguration = serde_json::from_value(serde_json::json!({
            "schemaVersion":1,"sandboxPolicy":{"schemaVersion":2},
            "deviceProvider":{"implementation":"builtin.darwin-device-v1"}
        }))
        .unwrap();
        let mut host = HostState::new(None, String::new(), Instant::now());
        host.control = Some(ControlState::new_with_inspector(
            configuration,
            None,
            false,
            false,
        ));
        let shared: SharedState = Rc::new(RefCell::new(host));
        let mut isolate = v8::Isolate::new(v8::CreateParams::default());
        isolate.set_slot(shared.clone());
        {
            v8::scope!(let scope, &mut isolate);
            let context = v8::Context::new(scope, Default::default());
            let scope = &mut v8::ContextScope::new(scope, context);
            let callback = v8::Function::builder(dispatch)
                .data(v8::Integer::new(scope, DEVICE_OPERATION).into())
                .build(scope)
                .unwrap();
            let call = |scope: &mut v8::PinScope, value: serde_json::Value| {
                let input = v8::String::new(scope, &value.to_string()).unwrap();
                let output = callback
                    .call(scope, context.global(scope).into(), &[input.into()])
                    .unwrap();
                serde_json::from_str::<serde_json::Value>(&output.to_rust_string_lossy(scope))
                    .unwrap()
            };
            let installed = call(
                scope,
                serde_json::json!({
                    "schemaVersion":1,"kind":"install","generation":1,"policy":{
                        "defaultAccess":"deny","maxEventsPerSecond":1,
                        "maxQueuedEvents":0,"maxSubscriptions":0,"operations":{}
                    }
                }),
            );
            assert_eq!(installed["ok"], true);
            let read = call(
                scope,
                serde_json::json!({
                    "schemaVersion":1,"kind":"read","generation":1,
                    "operation":"device.display.read","maxPrecision":"exact","maxPrivacyTier":1
                }),
            );
            assert_eq!(read["code"], "capability.denied");
            let closed = call(
                scope,
                serde_json::json!({
                    "schemaVersion":1,"kind":"close","generation":1
                }),
            );
            assert_eq!(closed["value"]["closed"], true);
        }
        isolate.remove_slot::<SharedState>();
        drop(shared);
    }
}

#[cfg(all(test, feature = "v86-backend"))]
mod vm_tests {
    use super::*;
    use crate::{
        control::ControlState,
        state::{HostState, SharedState},
    };
    use holonomy_desktop_host::HostConfiguration;
    use sha2::Digest;
    use std::{cell::RefCell, rc::Rc, time::Instant};

    #[test]
    fn bare_host_control_installs_encoding_and_checkpoint_microtasks() {
        crate::driver::initialize_engine();
        let configuration: HostConfiguration = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "sandboxPolicy": {"schemaVersion": 2}
        }))
        .unwrap();
        let mut host = HostState::new(None, String::new(), Instant::now());
        host.control = Some(ControlState::new(configuration, None));
        let shared: SharedState = Rc::new(RefCell::new(host));
        let mut isolate = v8::Isolate::new(v8::CreateParams::default());
        isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
        isolate.set_slot(shared.clone());
        {
            v8::scope!(let scope, &mut isolate);
            let context = v8::Context::new(scope, Default::default());
            let scope = &mut v8::ContextScope::new(scope, context);
            assert!(super::initialize(scope).is_some());
            let context = shared
                .borrow()
                .control
                .as_ref()
                .unwrap()
                .context
                .as_ref()
                .unwrap()
                .clone();
            let context = v8::Local::new(scope, context);
            let scope = &mut v8::ContextScope::new(scope, context);
            let source = v8::String::new(scope, r#"
                const bytes = new TextEncoder().encode('é')
                if (bytes.length !== 2 || bytes[0] !== 0xc3 || bytes[1] !== 0xa9) throw new Error('encode')
                let rejected = false
                try { new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff])) }
                catch (error) { rejected = error instanceof TypeError }
                if (!rejected) throw new Error('fatal decode')
                globalThis.__holoMicrotaskProbe = 0
                queueMicrotask(() => { globalThis.__holoMicrotaskProbe = 1 })
            "#).unwrap();
            assert!(
                v8::Script::compile(scope, source, None)
                    .unwrap()
                    .run(scope)
                    .is_some()
            );
            let read = v8::String::new(scope, "globalThis.__holoMicrotaskProbe").unwrap();
            let before = v8::Script::compile(scope, read, None)
                .unwrap()
                .run(scope)
                .unwrap();
            assert_eq!(before.int32_value(scope), Some(0));
            scope.perform_microtask_checkpoint();
            let after = v8::Script::compile(scope, read, None)
                .unwrap()
                .run(scope)
                .unwrap();
            assert_eq!(after.int32_value(scope), Some(1));
        }
        isolate.remove_slot::<SharedState>();
        drop(shared);
    }

    #[test]
    #[ignore = "requires verified v86 production assets"]
    fn native_host_callback_opens_and_closes_vm_in_second_isolate() {
        crate::driver::initialize_engine();
        let asset_root = std::env::var("HOLO_V86_PRODUCTION_ASSET_ROOT").unwrap();
        let root = std::path::PathBuf::from(asset_root).canonicalize().unwrap();
        let spec = |name: &str| {
            let bytes = std::fs::read(root.join(name)).unwrap();
            serde_json::json!({
                "size": bytes.len(),
                "sha256": format!("{:x}", sha2::Sha256::digest(&bytes))
            })
        };
        let configuration: HostConfiguration = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "sandboxPolicy": {"schemaVersion": 2}
        }))
        .unwrap();
        let mut host = HostState::new(None, String::new(), Instant::now());
        host.control = Some(ControlState::new(configuration, None));
        let shared: SharedState = Rc::new(RefCell::new(host));
        let mut isolate = v8::Isolate::new(v8::CreateParams::default());
        isolate.set_slot(shared.clone());
        {
            v8::scope!(let scope, &mut isolate);
            let context = v8::Context::new(scope, Default::default());
            let scope = &mut v8::ContextScope::new(scope, context);
            let callback = v8::Function::builder(dispatch)
                .data(v8::Integer::new(scope, V86_OPERATION).into())
                .build(scope)
                .unwrap();
            let call = |scope: &mut v8::PinScope, value: serde_json::Value| {
                let input = v8::String::new(scope, &value.to_string()).unwrap();
                let result = callback
                    .call(scope, context.global(scope).into(), &[input.into()])
                    .unwrap();
                serde_json::from_str::<serde_json::Value>(&result.to_rust_string_lossy(scope))
                    .unwrap()
            };
            let install = call(
                scope,
                serde_json::json!({
                    "schemaVersion": 1, "kind": "install", "root": root,
                    "bios": spec("seabios.bin"),
                    "kernel": spec("kernel.bin"),
                    "initrd": spec("agent.cpio"),
                    "wasmSha256": format!("{:x}", sha2::Sha256::digest(crate::v86_probe::V86_WASM))
                }),
            );
            assert_eq!(install["ok"], true, "{install}");
            let opened = call(
                scope,
                serde_json::json!({
                    "schemaVersion": 1, "kind": "open", "id": "isolate-probe",
                    "generation": 1, "memoryBytes": 134217728
                }),
            );
            assert_eq!(opened["value"]["status"], "open", "{opened}");
            let closed = call(
                scope,
                serde_json::json!({
                    "schemaVersion": 1, "kind": "close", "id": "isolate-probe", "generation": 1
                }),
            );
            assert_eq!(closed["value"]["closed"], true, "{closed}");
        }
        isolate.remove_slot::<SharedState>();
        drop(shared);
    }

    #[test]
    fn native_host_callback_fails_closed_on_missing_assets_without_guest_entry() {
        crate::driver::initialize_engine();
        let configuration: HostConfiguration = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "sandboxPolicy": {"schemaVersion": 2}
        }))
        .unwrap();
        let mut host = HostState::new(None, String::new(), Instant::now());
        host.control = Some(ControlState::new(configuration, None));
        let shared: SharedState = Rc::new(RefCell::new(host));
        let mut isolate = v8::Isolate::new(v8::CreateParams::default());
        isolate.set_slot(shared.clone());
        {
            v8::scope!(let scope, &mut isolate);
            let context = v8::Context::new(scope, Default::default());
            let scope = &mut v8::ContextScope::new(scope, context);
            let data = v8::Integer::new(scope, V86_OPERATION);
            let callback = v8::Function::builder(dispatch)
                .data(data.into())
                .build(scope)
                .unwrap();
            let missing = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "holo-v86-absent-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let input = serde_json::json!({
                "schemaVersion":1,"kind":"install","root":missing,
                "bios":{"size":1,"sha256":"0".repeat(64)},
                "kernel":{"size":1,"sha256":"0".repeat(64)},
                "initrd":{"size":1,"sha256":"0".repeat(64)},
                "wasmSha256":format!("{:x}", sha2::Sha256::digest(crate::v86_probe::V86_WASM))
            })
            .to_string();
            let argument = v8::String::new(scope, &input).unwrap();
            let receiver = context.global(scope);
            let result = callback
                .call(scope, receiver.into(), &[argument.into()])
                .unwrap();
            let result: serde_json::Value =
                serde_json::from_str(&result.to_rust_string_lossy(scope)).unwrap();
            assert_eq!(result["code"], "artifact");
            assert!(!shared.borrow().control.as_ref().unwrap().active());
        }
        isolate.remove_slot::<SharedState>();
        drop(shared);
    }
}
