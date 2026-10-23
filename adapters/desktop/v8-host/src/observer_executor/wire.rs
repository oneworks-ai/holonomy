//! Fixed helper protocol. The child can report only identity, status and a
//! Boolean publish request; JS values and errors never enter response bytes.
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

pub(super) const INIT: u8 = 1;
pub(super) const CALL: u8 = 2;
pub(super) const READY: u8 = 0x81;
pub(super) const STARTED: u8 = 0x82;
pub(super) const COMPLETED: u8 = 0x83;
pub(super) const RESPONSE_BYTES: usize = 32;
pub(super) const MAX_INIT_BYTES: usize = holonomy_desktop_host::MAX_GRAPH_BYTES * 8 + 131_072;
pub(super) const MAX_CALL_BYTES: usize = 9_000;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct InitRequest {
    pub profile_id: String,
    pub plan: String,
    pub bundle_sha256: String,
    pub export_name: String,
    pub config: serde_json::Value,
    pub epoch: u32,
    pub nonce: [u8; 16],
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CallRequest {
    pub epoch: u32,
    pub sequence: u64,
    pub nonce: [u8; 16],
    pub event: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Response {
    pub kind: u8,
    pub epoch: u32,
    pub sequence: u64,
    pub nonce: [u8; 16],
    pub failed: bool,
    pub published: bool,
}
impl Response {
    pub fn encode(self) -> [u8; RESPONSE_BYTES] {
        let mut bytes = [0; RESPONSE_BYTES];
        bytes[0] = self.kind;
        bytes[1..5].copy_from_slice(&self.epoch.to_be_bytes());
        bytes[5..13].copy_from_slice(&self.sequence.to_be_bytes());
        bytes[13..29].copy_from_slice(&self.nonce);
        bytes[29] = u8::from(self.failed);
        bytes[30] = u8::from(self.published);
        bytes
    }

    pub fn decode(bytes: [u8; RESPONSE_BYTES]) -> Option<Self> {
        let kind = bytes[0];
        if !matches!(kind, READY | STARTED | COMPLETED)
            || bytes[29] > 1
            || bytes[30] > 1
            || bytes[31] != 0
        {
            return None;
        }
        Some(Self {
            kind,
            epoch: u32::from_be_bytes(bytes[1..5].try_into().ok()?),
            sequence: u64::from_be_bytes(bytes[5..13].try_into().ok()?),
            nonce: bytes[13..29].try_into().ok()?,
            failed: bytes[29] != 0,
            published: bytes[30] != 0,
        })
    }
}

pub(super) fn frame(kind: u8, payload: &[u8], limit: usize) -> Option<Vec<u8>> {
    if payload.len() > limit || payload.len() > u32::MAX as usize {
        return None;
    }
    let mut bytes = Vec::with_capacity(5 + payload.len());
    bytes.push(kind);
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(payload);
    Some(bytes)
}

pub(super) fn read_frame<R: Read>(reader: &mut R) -> io::Result<(u8, Vec<u8>)> {
    let mut header = [0; 5];
    reader.read_exact(&mut header)?;
    let size = u32::from_be_bytes(header[1..5].try_into().unwrap()) as usize;
    let limit = match header[0] {
        INIT => MAX_INIT_BYTES,
        CALL => MAX_CALL_BYTES,
        _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "frame kind")),
    };
    if size > limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame size"));
    }
    let mut payload = vec![0; size];
    reader.read_exact(&mut payload)?;
    Ok((header[0], payload))
}

pub(super) fn write_response<W: Write>(writer: &mut W, response: Response) -> io::Result<()> {
    writer.write_all(&response.encode())?;
    writer.flush()
}
