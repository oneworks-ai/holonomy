//! Source-free Guest engine events sent as bounded owned Host messages.
use crate::state::state;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(crate) struct Execution {
    script_id: String,
    execution_id: String,
}

fn script_id(url: &str) -> String {
    format!("native-script-{:x}", Sha256::digest(url.as_bytes()))
}

fn publish(scope: &v8::PinScope, event: &'static str, payload: Value) {
    let shared = state(scope);
    let state = shared.borrow();
    if state.closing {
        return;
    }
    if let Some(remote) = state.remote.as_ref() {
        remote.publish_observer(
            event,
            json!({ "event": event, "payload": payload }).to_string(),
        );
    }
}

pub(crate) fn compiled(scope: &v8::PinScope, url: &str, source: &str) {
    if url.len() > 4096 || source.len() > 16 * 1024 * 1024 {
        return;
    }
    let shared = state(scope);
    if !shared
        .borrow()
        .remote
        .as_ref()
        .is_some_and(|remote| remote.observer_enabled("script.compiled"))
    {
        return;
    }
    publish(
        scope,
        "script.compiled",
        json!({
            "origin": url,
            "scriptId": script_id(url),
            "sourceBytes": source.len(),
            "sourceSha256": format!("{:x}", Sha256::digest(source.as_bytes()))
        }),
    );
}

pub(crate) fn started(scope: &v8::PinScope, url: &str) -> Option<Execution> {
    let shared = state(scope);
    let enabled = shared.borrow().remote.as_ref().is_some_and(|remote| {
        remote.observer_enabled("script.execution-started")
            || remote.observer_enabled("script.execution-finished")
    });
    if !enabled {
        return None;
    }
    let sequence = {
        let mut state = shared.borrow_mut();
        state.observer_execution_sequence = state.observer_execution_sequence.checked_add(1)?;
        state.observer_execution_sequence
    };
    let execution = Execution {
        script_id: script_id(url),
        execution_id: format!("native-exec-{sequence}"),
    };
    publish(
        scope,
        "script.execution-started",
        json!({
            "executionId": execution.execution_id,
            "scriptId": execution.script_id
        }),
    );
    Some(execution)
}

pub(crate) fn finished(scope: &v8::PinScope, execution: Option<Execution>, outcome: &'static str) {
    if let Some(execution) = execution {
        publish(
            scope,
            "script.execution-finished",
            json!({
                "executionId": execution.execution_id,
                "outcome": outcome,
                "scriptId": execution.script_id
            }),
        );
    }
}

pub(crate) fn exception(scope: &v8::PinScope, code: &'static str) {
    publish(scope, "runtime.exception", json!({ "code": code }));
}

pub(crate) fn terminated(scope: &v8::PinScope, reason: &'static str) {
    publish(scope, "runtime.terminated", json!({ "reason": reason }));
}
