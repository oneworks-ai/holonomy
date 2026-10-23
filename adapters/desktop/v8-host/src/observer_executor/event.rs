//! Defensive Rust admission for the shared source-free ObserverEventV1 shape.
//! The Host registry already normalizes it; this guard prevents a mistaken
//! native caller from forwarding arbitrary JS objects or source text.
use serde_json::{Map, Value};

const MAX_SAFE: u64 = 9_007_199_254_740_991;
const EVENTS: &[&str] = &[
    "gc.completed",
    "memory.pressure",
    "promise.rejected",
    "runtime.exception",
    "runtime.terminated",
    "script.compiled",
    "script.execution-finished",
    "script.execution-started",
];

fn keys(input: &Map<String, Value>, required: &[&str], optional: &[&str]) -> bool {
    required.iter().all(|key| input.contains_key(*key))
        && input
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}
fn integer(value: &Value, min: u64, max: u64) -> Option<u64> {
    let number = value.as_u64()?;
    (min..=max).contains(&number).then_some(number)
}
fn id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
    })
}
fn source_sha(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    })
}
fn payload(event: &str, value: &Value) -> bool {
    let Some(input) = value.as_object() else {
        return false;
    };
    match event {
        "script.compiled" => {
            keys(
                input,
                &["scriptId", "sourceBytes", "sourceSha256"],
                &["origin"],
            ) && id(&input["scriptId"])
                && integer(&input["sourceBytes"], 0, 16 * 1024 * 1024).is_some()
                && source_sha(&input["sourceSha256"])
                && input.get("origin").is_none_or(|value| {
                    value
                        .as_str()
                        .is_some_and(|s| !s.is_empty() && s.len() <= 4096)
                })
        }
        "script.execution-started" => {
            keys(input, &["executionId", "scriptId"], &[])
                && id(&input["executionId"])
                && id(&input["scriptId"])
        }
        "script.execution-finished" => {
            keys(input, &["executionId", "outcome", "scriptId"], &[])
                && id(&input["executionId"])
                && id(&input["scriptId"])
                && matches!(
                    input["outcome"].as_str(),
                    Some("completed" | "terminated" | "threw")
                )
        }
        "promise.rejected" | "runtime.exception" => {
            keys(input, &["code"], &["scriptId"])
                && id(&input["code"])
                && input.get("scriptId").is_none_or(id)
        }
        "runtime.terminated" => {
            keys(input, &["reason"], &[])
                && matches!(
                    input["reason"].as_str(),
                    Some("completed" | "failed" | "lost" | "stopped")
                )
        }
        "memory.pressure" => {
            keys(input, &["level"], &[])
                && matches!(input["level"].as_str(), Some("critical" | "moderate"))
        }
        "gc.completed" => {
            keys(input, &["durationMs"], &["reclaimedBytes"])
                && input["durationMs"]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && (0.0..=120_000.0).contains(&n))
                && input
                    .get("reclaimedBytes")
                    .is_none_or(|v| integer(v, 0, MAX_SAFE).is_some())
        }
        "observer.overflow" => {
            if !keys(
                input,
                &[
                    "dropped",
                    "droppedByEvent",
                    "firstDroppedSequence",
                    "lastDroppedSequence",
                ],
                &[],
            ) {
                return false;
            }
            let Some(dropped) = integer(&input["dropped"], 1, MAX_SAFE) else {
                return false;
            };
            let Some(first) = integer(&input["firstDroppedSequence"], 1, MAX_SAFE) else {
                return false;
            };
            if integer(&input["lastDroppedSequence"], first, MAX_SAFE).is_none() {
                return false;
            }
            let Some(by_event) = input["droppedByEvent"].as_object() else {
                return false;
            };
            let mut sum = 0_u64;
            for (name, count) in by_event {
                if !EVENTS.contains(&name.as_str()) {
                    return false;
                }
                let Some(count) = integer(count, 1, MAX_SAFE) else {
                    return false;
                };
                let Some(next) = sum.checked_add(count) else {
                    return false;
                };
                sum = next;
            }
            sum == dropped
        }
        _ => false,
    }
}

pub(super) fn validate(encoded: &str) -> Option<Value> {
    if encoded.len() > 8 * 1024 {
        return None;
    }
    let value: Value = serde_json::from_str(encoded).ok()?;
    let input = value.as_object()?;
    if !keys(
        input,
        &[
            "event",
            "generation",
            "observedAt",
            "payload",
            "schemaVersion",
            "sequence",
        ],
        &["correlationId"],
    ) || integer(&input["schemaVersion"], 1, 1).is_none()
        || integer(&input["generation"], 1, MAX_SAFE).is_none()
        || integer(&input["sequence"], 1, MAX_SAFE).is_none()
        || !input["observedAt"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= 0.0)
        || !input.get("correlationId").is_none_or(id)
    {
        return None;
    }
    let event = input["event"].as_str()?;
    if !EVENTS.contains(&event) && event != "observer.overflow" {
        return None;
    }
    payload(event, &input["payload"]).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::validate;
    #[test]
    fn rejects_untrusted_source_and_extra_keys() {
        let valid = r#"{"schemaVersion":1,"event":"memory.pressure","generation":1,"observedAt":1,"sequence":1,"payload":{"level":"critical"}}"#;
        assert!(validate(valid).is_some());
        assert!(
            validate(&valid.replace("\"level\":", "\"source\":\"secret\",\"level\":")).is_none()
        );
        assert!(
            validate(&valid.replace("\"payload\":", "\"source\":\"secret\",\"payload\":"))
                .is_none()
        );
    }
}
