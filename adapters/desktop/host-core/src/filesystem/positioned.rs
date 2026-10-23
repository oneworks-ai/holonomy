//! Trusted Linux FUSE continuations over already-admitted file descriptors.
use super::{Result, io_error};
use serde_json::Value;
use std::{fs::File, io::Write, os::unix::fs::FileExt};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn offset(value: &Value, kind: &str, fields: usize) -> Result<u64> {
    let object = value.as_object().ok_or("argument.invalid")?;
    if object.len() != fields || object.get("kind").and_then(Value::as_str) != Some(kind) {
        return Err("argument.invalid");
    }
    value["offset"]
        .as_u64()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or("argument.invalid")
}

pub(super) fn read(file: &File, value: &Value, maximum: usize) -> Result<Vec<u8>> {
    let offset = offset(value, "positionedRead", 3)?;
    let size = value["size"].as_u64().ok_or("argument.invalid")?;
    if size > maximum as u64 {
        return Err("resource.byte_limit");
    }
    let mut bytes = vec![0; size as usize];
    let mut received = 0;
    while received < bytes.len() {
        let count = file
            .read_at(&mut bytes[received..], offset + received as u64)
            .map_err(io_error)?;
        if count == 0 {
            break;
        }
        received += count;
    }
    bytes.truncate(received);
    Ok(bytes)
}

pub(super) fn write(file: &File, value: &Value, bytes: &[u8], append: bool) -> Result<()> {
    let offset = offset(value, "positionedWrite", 2)?;
    if append {
        let mut file = file;
        file.write_all(bytes).map_err(io_error)
    } else {
        file.write_all_at(bytes, offset).map_err(io_error)
    }
}
