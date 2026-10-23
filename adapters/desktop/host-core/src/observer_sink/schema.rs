//! Closed RuntimeObserverEventV1 and output status validation.
use super::{MAX_EVENT_BYTES, MAX_SAFE, ObserverOutputRecord, ObserverOutputStatus};
use serde_json::{Map, Value};

pub(super) fn valid_output_record(record: &ObserverOutputRecord) -> bool {
    if record.epoch == 0 {
        return false;
    }
    match record.status {
        ObserverOutputStatus::Event => {
            record.dropped == 0 && record.event.as_ref().is_some_and(valid_runtime_event)
        }
        ObserverOutputStatus::CallbackStarted
        | ObserverOutputStatus::CallbackFailed
        | ObserverOutputStatus::CallbackTimeout => {
            record.dropped == 0 && record.event.as_ref().is_none_or(valid_runtime_event)
        }
        ObserverOutputStatus::QueueDropped => {
            record.event.is_none() && (1..=MAX_SAFE).contains(&record.dropped)
        }
        ObserverOutputStatus::ProfileDisabled | ObserverOutputStatus::InitializationFailed => {
            record.event.is_none() && record.dropped == 0
        }
    }
}

fn valid_runtime_event(value: &Value) -> bool {
    let Ok(bytes) = serde_json::to_vec(value) else {
        return false;
    };
    if bytes.len() > MAX_EVENT_BYTES {
        return false;
    }
    let Some(input) = value.as_object() else {
        return false;
    };
    if !exact_keys(
        input,
        &[
            "correlationId",
            "event",
            "generation",
            "observedAt",
            "payload",
            "schemaVersion",
            "sequence",
        ],
    ) || input.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || !input
            .get("generation")
            .is_some_and(|value| safe_integer(value, 1, MAX_SAFE))
        || !input
            .get("sequence")
            .is_some_and(|value| safe_integer(value, 1, MAX_SAFE))
        || !input.get("observedAt").is_some_and(|value| {
            value
                .as_f64()
                .is_some_and(|number| number.is_finite() && number >= 0.0)
        })
        || input
            .get("correlationId")
            .is_some_and(|value| !value.as_str().is_some_and(valid_event_id))
    {
        return false;
    }
    let Some(event) = input.get("event").and_then(Value::as_str) else {
        return false;
    };
    let Some(payload) = input.get("payload").and_then(Value::as_object) else {
        return false;
    };
    match event {
        "script.compiled" => {
            exact_keys(
                payload,
                &["origin", "scriptId", "sourceBytes", "sourceSha256"],
            ) && payload
                .get("scriptId")
                .and_then(Value::as_str)
                .is_some_and(valid_event_id)
                && payload
                    .get("sourceBytes")
                    .is_some_and(|value| safe_integer(value, 0, 16 * 1024 * 1024))
                && payload
                    .get("sourceSha256")
                    .and_then(Value::as_str)
                    .is_some_and(valid_digest)
                && payload.get("origin").is_none_or(|value| {
                    value
                        .as_str()
                        .is_some_and(|text| !text.is_empty() && text.len() <= 4096)
                })
        }
        "script.execution-started" => {
            exact_keys(payload, &["executionId", "scriptId"])
                && payload
                    .get("executionId")
                    .and_then(Value::as_str)
                    .is_some_and(valid_event_id)
                && payload
                    .get("scriptId")
                    .and_then(Value::as_str)
                    .is_some_and(valid_event_id)
        }
        "script.execution-finished" => {
            exact_keys(payload, &["executionId", "outcome", "scriptId"])
                && payload
                    .get("executionId")
                    .and_then(Value::as_str)
                    .is_some_and(valid_event_id)
                && payload
                    .get("scriptId")
                    .and_then(Value::as_str)
                    .is_some_and(valid_event_id)
                && payload
                    .get("outcome")
                    .and_then(Value::as_str)
                    .is_some_and(|text| matches!(text, "completed" | "terminated" | "threw"))
        }
        "promise.rejected" | "runtime.exception" => {
            exact_keys(payload, &["code", "scriptId"])
                && payload
                    .get("code")
                    .and_then(Value::as_str)
                    .is_some_and(valid_event_id)
                && payload
                    .get("scriptId")
                    .is_none_or(|value| value.as_str().is_some_and(valid_event_id))
        }
        "runtime.terminated" => {
            exact_keys(payload, &["reason"])
                && payload
                    .get("reason")
                    .and_then(Value::as_str)
                    .is_some_and(|text| matches!(text, "completed" | "failed" | "lost" | "stopped"))
        }
        "memory.pressure" => {
            exact_keys(payload, &["level"])
                && payload
                    .get("level")
                    .and_then(Value::as_str)
                    .is_some_and(|text| matches!(text, "critical" | "moderate"))
        }
        "gc.completed" => {
            exact_keys(payload, &["durationMs", "reclaimedBytes"])
                && payload
                    .get("durationMs")
                    .and_then(Value::as_f64)
                    .is_some_and(|number| number.is_finite() && (0.0..=120_000.0).contains(&number))
                && payload
                    .get("reclaimedBytes")
                    .is_none_or(|value| safe_integer(value, 0, MAX_SAFE))
        }
        "observer.overflow" => valid_overflow(payload),
        _ => false,
    }
}

fn valid_overflow(payload: &Map<String, Value>) -> bool {
    if !exact_keys(
        payload,
        &[
            "dropped",
            "droppedByEvent",
            "firstDroppedSequence",
            "lastDroppedSequence",
        ],
    ) || !payload
        .get("dropped")
        .is_some_and(|value| safe_integer(value, 1, MAX_SAFE))
        || !payload
            .get("firstDroppedSequence")
            .is_some_and(|value| safe_integer(value, 1, MAX_SAFE))
        || !payload
            .get("lastDroppedSequence")
            .is_some_and(|value| safe_integer(value, 1, MAX_SAFE))
    {
        return false;
    }
    let first = payload["firstDroppedSequence"].as_u64().unwrap();
    let last = payload["lastDroppedSequence"].as_u64().unwrap();
    let Some(by_event) = payload.get("droppedByEvent").and_then(Value::as_object) else {
        return false;
    };
    if by_event.len() > 8 || last < first {
        return false;
    }
    let mut sum = 0u64;
    for (event, count) in by_event {
        if !matches!(
            event.as_str(),
            "gc.completed"
                | "memory.pressure"
                | "promise.rejected"
                | "runtime.exception"
                | "runtime.terminated"
                | "script.compiled"
                | "script.execution-finished"
                | "script.execution-started"
        ) || !safe_integer(count, 1, MAX_SAFE)
        {
            return false;
        }
        sum = match sum.checked_add(count.as_u64().unwrap()) {
            Some(value) if value <= MAX_SAFE => value,
            _ => return false,
        };
    }
    sum == payload["dropped"].as_u64().unwrap()
}

fn exact_keys(value: &Map<String, Value>, allowed: &[&str]) -> bool {
    value.keys().all(|key| allowed.contains(&key.as_str()))
}
fn safe_integer(value: &Value, minimum: u64, maximum: u64) -> bool {
    value
        .as_u64()
        .is_some_and(|number| (minimum..=maximum).contains(&number))
}
fn valid_event_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
}
pub(super) fn valid_profile_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && crate::plugins::valid_id(value)
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub(super) fn valid_session(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
