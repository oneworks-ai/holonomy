//! Host-owned bounded metadata audit; source bytes never enter this owner.
use crate::{SourceAdmission, secure_metadata_file::PrivateMetadataFile};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiagnosticAuditInstallation {
    pub path: PathBuf,
    pub max_bytes: u64,
}
impl DiagnosticAuditInstallation {
    pub fn validate(&self) -> Result<(), String> {
        if !self.path.is_absolute()
            || self.path.as_os_str().len() > 4096
            || !(1024..=16 * 1024 * 1024).contains(&self.max_bytes)
        {
            return Err("Invalid diagnostic audit installation".into());
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceRead {
    request_id: u64,
    code_kind: CodeKind,
    source_sha256: String,
    source_bytes: u64,
    read_bytes: u64,
}
impl SourceRead {
    fn valid(&self) -> bool {
        self.request_id > 0
            && self.request_id <= 9_007_199_254_740_991
            && self.source_bytes <= 16 * 1024 * 1024
            && self.read_bytes <= 64 * 1024
            && self.read_bytes <= self.source_bytes
            && self.source_sha256.len() == 64
            && self
                .source_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PriorRecord {
    schema_version: u32,
    event: String,
    session_id: String,
    sequence: u64,
    generation: u64,
    observed_at: u64,
    request: SourceRead,
}
fn validate_existing(file: &File, maximum: u64) -> Result<(), String> {
    let mut reader = BufReader::new(file);
    let mut total = 0;
    loop {
        let mut line = Vec::new();
        reader
            .by_ref()
            .take(1025)
            .read_until(b'\n', &mut line)
            .map_err(|_| "Diagnostic audit history is unavailable")?;
        if line.is_empty() {
            return Ok(());
        }
        total += line.len() as u64;
        if total > maximum || line.len() > 1024 || line.last() != Some(&b'\n') {
            return Err("Diagnostic audit history is incomplete".into());
        }
        let row: PriorRecord =
            serde_json::from_slice(&line).map_err(|_| "Diagnostic audit history is invalid")?;
        if row.schema_version != 1
            || row.event != "source.read.admitted"
            || row.generation != 1
            || row.sequence == 0
            || row.sequence > 9_007_199_254_740_991
            || row.observed_at > 9_007_199_254_740_991
            || !row.request.valid()
            || row.session_id.len() != 32
            || !row
                .session_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Diagnostic audit history is invalid".into());
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum CodeKind {
    Strings,
    Wasm,
    Module,
}

#[derive(Debug)]
pub struct NativeDiagnosticAudit {
    file: PrivateMetadataFile,
    session: String,
    sequence: u64,
    failed: bool,
}

impl NativeDiagnosticAudit {
    pub fn open(
        config: &DiagnosticAuditInstallation,
        admission: &SourceAdmission,
    ) -> Result<Self, String> {
        config.validate()?;
        let file = PrivateMetadataFile::open(&config.path, config.max_bytes, admission, false)?;
        validate_existing(file.file(), config.max_bytes)?;
        file.label(admission)?;
        let mut session = [0u8; 16];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut session)
            .map_err(|_| "Diagnostic audit session is unavailable")?;
        let session = session.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Self {
            file,
            session,
            sequence: 0,
            failed: false,
        })
    }

    pub fn record_source_read(&mut self, encoded: &str) -> bool {
        if self.failed || encoded.len() > 1024 {
            return false;
        }
        let Ok(input) = serde_json::from_str::<SourceRead>(encoded) else {
            return false;
        };
        if !input.valid() {
            return false;
        }
        let Some(sequence) = self.sequence.checked_add(1) else {
            return false;
        };
        let observed_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let mut line = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "event": "source.read.admitted", "sessionId": self.session,
            "sequence": sequence, "generation": 1, "observedAt": observed_at,
            "request": input,
        }))
        .expect("Serializable audit metadata");
        line.push(b'\n');
        if self.file.append(&line, true).is_err() {
            self.failed = true;
            return false;
        }
        self.sequence = sequence;
        true
    }
}

#[cfg(test)]
mod tests;
