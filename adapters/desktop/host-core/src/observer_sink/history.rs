//! Strict validation of prior output before any append.
use super::schema::{valid_output_record, valid_session};
use super::{MAX_RECORD_BYTES, MAX_SAFE, ObserverOutputRecord, ObserverOutputStatus};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Read},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PriorRecord {
    schema_version: u32,
    session_id: String,
    sequence: u64,
    generation: u32,
    profile_id: String,
    epoch: u32,
    observed_at: u64,
    status: ObserverOutputStatus,
    #[serde(default)]
    source_event: Option<Value>,
    #[serde(default)]
    dropped: Option<u64>,
}

pub(super) fn validate_history(file: &File, maximum: u64, profile_id: &str) -> Result<(), String> {
    let mut reader = BufReader::new(file);
    let mut total = 0u64;
    let mut sequences = HashMap::<String, u64>::new();
    loop {
        let mut line = Vec::new();
        reader
            .by_ref()
            .take((MAX_RECORD_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| "Observer sink history is unavailable")?;
        if line.is_empty() {
            return Ok(());
        }
        total = total.saturating_add(line.len() as u64);
        if total > maximum || line.len() > MAX_RECORD_BYTES || line.last() != Some(&b'\n') {
            return Err("Observer sink history is incomplete".into());
        }
        let raw: Value =
            serde_json::from_slice(&line).map_err(|_| "Observer sink history is invalid")?;
        let raw_object = raw.as_object().ok_or("Observer sink history is invalid")?;
        let has_event = raw_object.contains_key("sourceEvent");
        let has_dropped = raw_object.contains_key("dropped");
        let row: PriorRecord =
            serde_json::from_value(raw).map_err(|_| "Observer sink history is invalid")?;
        let record = ObserverOutputRecord {
            epoch: row.epoch,
            status: row.status,
            event: row.source_event,
            dropped: row.dropped.unwrap_or(0),
        };
        if row.schema_version != 1
            || row.generation != 1
            || row.profile_id != profile_id
            || row.sequence == 0
            || row.sequence > MAX_SAFE
            || row.observed_at > MAX_SAFE
            || !valid_session(&row.session_id)
            || !valid_output_record(&record)
            || has_event != record.event.is_some()
            || (record.status == ObserverOutputStatus::QueueDropped) != has_dropped
            || has_dropped != row.dropped.is_some()
            || sequences
                .get(&row.session_id)
                .is_some_and(|previous| *previous >= row.sequence)
            || (sequences.len() >= 4096 && !sequences.contains_key(&row.session_id))
        {
            return Err("Observer sink history is invalid".into());
        }
        sequences.insert(row.session_id, row.sequence);
    }
}
