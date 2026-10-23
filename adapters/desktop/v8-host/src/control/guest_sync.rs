use super::transport::SyncMethod;
use crate::state::{error, state};
use std::time::Instant;
fn invoke_remote(scope: &v8::PinScope, name: &str, arguments: &[String]) -> Option<String> {
    let method = SyncMethod::parse(name)?;
    let shared = state(scope);
    let state = shared.borrow();
    state
        .remote
        .as_ref()?
        .invoke(method, arguments.to_vec())
        .ok()
}
pub fn invoke(scope: &mut v8::PinScope, name: &str, arguments: &[String]) -> Option<String> {
    let response = invoke_remote(scope, name, arguments);
    if response.is_none() {
        let exception = error(scope, "Host capability execution failed");
        scope.throw_exception(exception);
    }
    response
}

pub fn decide_engine_code(
    scope: &mut v8::PinScope,
    request_id: u64,
    source_bytes: usize,
    source_sha256: &str,
    source_prefix: Option<zeroize::Zeroizing<Vec<u8>>>,
) -> bool {
    let request = serde_json::json!({
        "codeKind": "strings",
        "requestId": request_id,
        "sourceBytes": source_bytes,
        "sourceSha256": source_sha256,
    });
    let request = request.to_string();
    let started = Instant::now();
    let response = state(scope)
        .borrow()
        .remote
        .as_ref()
        .and_then(|remote| remote.gate_strings(request_id, request, source_prefix));
    let Some(response) = response else {
        return false;
    };
    let Ok(response) = serde_json::from_str::<serde_json::Value>(&response) else {
        return false;
    };
    let Some(timeout_ms) = response
        .get("decisionTimeoutMs")
        .and_then(|value| value.as_u64())
    else {
        return false;
    };
    if !(1..=120_000).contains(&timeout_ms)
        || started.elapsed().as_millis() > u128::from(timeout_ms)
    {
        return false;
    }
    response
        .get("decision")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|decision| {
            decision.len() == 1
                && decision
                    .get("action")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|action| action == "allow")
        })
}
