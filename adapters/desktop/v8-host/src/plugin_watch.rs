//! A single in-flight Host plugin graph update. Never drives Guest callbacks directly.
use crate::{
    control,
    state::{SharedState, state},
};
use holonomy_desktop_host::{HostConfiguration, PluginConfigWatch};
use serde_json::Value;
use std::{path::PathBuf, time::Instant};

pub struct PluginWatchState {
    config: PluginConfigWatch,
    service_ack: bool,
    revision: u64,
    host_revision: u64,
    armed: bool,
    pending: Option<(v8::Global<v8::Promise>, Value)>,
    validating: Option<(HostConfiguration, crate::plugin_schema::PendingValidation)>,
}

impl PluginWatchState {
    pub fn new(path: PathBuf, initial: &HostConfiguration, service_ack: bool) -> Self {
        Self {
            config: PluginConfigWatch::new(path, initial),
            service_ack,
            revision: initial
                .plugin_graph_revision
                .unwrap_or(u64::from(!initial.runtime_plugins.is_empty())),
            host_revision: u64::from(!initial.runtime_plugins.is_empty()),
            armed: false,
            pending: None,
            validating: None,
        }
    }
    pub fn active(&self) -> bool {
        (!self.service_ack && self.armed) || self.pending.is_some() || self.validating.is_some()
    }
    pub fn stop(&mut self) {
        self.armed = false;
        self.validating = None;
    }
}

pub fn arm(shared: &SharedState) {
    if let Some(watch) = shared
        .borrow_mut()
        .control
        .as_mut()
        .and_then(|control| control.watch.as_mut())
    {
        watch.armed = true;
        eprintln!("holo: plugin watch ready");
        if watch.service_ack {
            acknowledge("ready", watch.revision, true);
        }
    }
}

pub fn pump(scope: &mut v8::PinScope) -> Option<bool> {
    let shared = state(scope);
    let (context, pending) = {
        let mut state = shared.borrow_mut();
        let control = state.control.as_mut()?;
        let Some(watch) = control.watch.as_mut() else {
            return Some(false);
        };
        (control.context.as_ref()?.clone(), watch.pending.take())
    };
    if let Some((promise, plugins)) = pending {
        let status = {
            let context = v8::Local::new(scope, &context);
            let scope = &mut v8::ContextScope::new(scope, context);
            let promise = v8::Local::new(scope, &promise);
            match promise.state() {
                v8::PromiseState::Pending => None,
                v8::PromiseState::Fulfilled => {
                    Some(promise.result(scope).to_rust_string_lossy(scope))
                }
                v8::PromiseState::Rejected => Some(String::new()),
            }
        };
        let mut state = shared.borrow_mut();
        let watch = state.control.as_mut()?.watch.as_mut()?;
        if let Some(status) = status {
            let value: Value = serde_json::from_str(&status).unwrap_or(Value::Null);
            let revision = value["revision"].as_u64();
            if value["ok"] == true && revision == watch.host_revision.checked_add(1) {
                watch.config.commit(plugins);
                watch.host_revision = revision.unwrap();
                watch.revision += 1;
                eprintln!("holo: plugin graph revision {} active", watch.host_revision);
                if watch.service_ack {
                    acknowledge("update", watch.revision, true);
                }
            } else {
                eprintln!("holo: plugin update rejected; previous graph remains active");
                if watch.service_ack {
                    acknowledge("update", watch.revision + 1, false);
                }
            }
            return Some(true);
        }
        watch.pending = Some((promise, plugins));
        return Some(false);
    }
    let candidate = next_candidate(&shared);
    let mut candidate = match candidate {
        Ok(Some(candidate)) => candidate,
        Ok(None) => return Some(false),
        Err(reason) => {
            eprintln!("holo: plugin update rejected ({reason}); previous graph remains active");
            let shared = shared.borrow();
            let watch = shared.control.as_ref()?.watch.as_ref()?;
            if watch.service_ack {
                acknowledge("update", watch.revision + 1, false);
            }
            return Some(true);
        }
    };
    let plugins = PluginConfigWatch::plugins(&candidate);
    let installations = serde_json::to_string(&candidate.runtime_plugins).ok()?;
    // Each attempt owns fresh descriptors and source snapshots. Executable old
    // graphs retain their immutable V8 definitions, never this disk reader.
    shared.borrow_mut().control.as_mut()?.plugins = std::mem::take(&mut candidate.plugin_sources);
    let promise = control::invoke_host_promise(scope, "replacePlugins", &[installations])?;
    shared
        .borrow_mut()
        .control
        .as_mut()?
        .watch
        .as_mut()?
        .pending = Some((promise, plugins));
    Some(true)
}

fn acknowledge(event: &str, revision: u64, applied: bool) {
    let line = format!("{{\"event\":\"{event}\",\"revision\":{revision},\"applied\":{applied}}}\n");
    let bytes = line.as_bytes();
    // FD 3 exists only for Service-owned runtimes. A short single write is
    // atomic on the private pipe; failure leaves Service awaiting a timeout.
    unsafe { libc::write(3, bytes.as_ptr().cast(), bytes.len()) };
}

fn next_candidate(shared: &SharedState) -> Result<Option<HostConfiguration>, &'static str> {
    let mut state = shared.borrow_mut();
    let Some(watch) = state
        .control
        .as_mut()
        .and_then(|control| control.watch.as_mut())
    else {
        return Ok(None);
    };
    if !watch.armed {
        return Ok(None);
    }
    if let Some((candidate, validation)) = watch.validating.take() {
        return match validation.poll() {
            Some(Ok(())) => Ok(Some(candidate)),
            Some(Err(_)) => Err("schema validation failed"),
            None => {
                watch.validating = Some((candidate, validation));
                Ok(None)
            }
        };
    }
    if let Some(candidate) = watch.config.poll(Instant::now())? {
        let validation = crate::plugin_schema::begin(&candidate.runtime_plugins)?;
        watch.validating = Some((candidate, validation));
    }
    Ok(None)
}
