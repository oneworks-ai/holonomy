//! Native V8 code-generation callbacks for the desktop guest Context.
//!
//! The isolate callbacks are the final enforcement point. Rust does not parse
//! SandboxPolicy or make an allow decision: it snapshots only safe string
//! metadata and synchronously asks the isolated Host Context to compile the
//! shared Engine Gate request and await its decision on the independent worker.
//! The original Guest source/Context are never replaced. Wasm ignores V8's
//! placeholder callback string and consumes only a native BufferSource stage.

use crate::state::state;
use sha2::{Digest, Sha256};
use std::time::Instant;
use zeroize::Zeroizing;

const GUEST_CONTEXT_MARKER: i32 = 1;
// This is the shared EngineGate v1 metadata envelope's maximum sourceBytes
// value, not a desktop policy limit. Enforce it before making a Rust snapshot.
pub(crate) const MAX_ENGINE_GATE_SOURCE_BYTES: usize = 16 * 1024 * 1024;

pub struct EngineGate {
    next_request_id: u64,
    wasm_callbacks: u64,
    staged_wasm: Option<crate::wasm::StagedWasmSource>,
}

impl EngineGate {
    pub fn new() -> Self {
        Self {
            next_request_id: 0,
            wasm_callbacks: 0,
            staged_wasm: None,
        }
    }

    pub(crate) fn next_request_id(&mut self) -> Option<u64> {
        self.next_request_id = self.next_request_id.checked_add(1)?;
        Some(self.next_request_id)
    }

    fn record_wasm_callback(&mut self) {
        self.wasm_callbacks = self.wasm_callbacks.saturating_add(1);
    }

    pub(crate) fn stage_wasm(
        &mut self,
        scope: &mut v8::PinScope,
        source: v8::Local<v8::Value>,
        operation: i32,
        timeout: std::time::Duration,
    ) -> Option<String> {
        if self.staged_wasm.is_some() {
            return None;
        }
        let request_id = self.next_request_id()?;
        let stage = crate::wasm::StagedWasmSource::capture(
            scope,
            source,
            crate::wasm::GENERATION,
            request_id,
            operation,
            timeout,
        )?;
        let token = stage.token();
        self.staged_wasm = Some(stage);
        Some(token)
    }

    pub(crate) fn clear_wasm(&mut self, token: &str) {
        if self
            .staged_wasm
            .as_ref()
            .is_some_and(|stage| stage.token() == token)
        {
            self.staged_wasm = None;
        }
    }
}

pub fn mark_guest_context(scope: &mut v8::PinScope, context: v8::Local<v8::Context>) {
    context.set_embedder_data(GUEST_CONTEXT_MARKER, v8::Boolean::new(scope, true).into());
}

fn guest_context(scope: &v8::PinScope) -> bool {
    scope
        .get_current_context()
        .get_embedder_data(scope, GUEST_CONTEXT_MARKER)
        .is_some_and(|value| value.is_true())
}

pub fn install(isolate: &mut v8::OwnedIsolate) {
    isolate.set_modify_code_generation_from_strings_callback(strings_callback);
    isolate.set_allow_wasm_code_generation_callback(wasm_callback);
}

fn strings_callback<'s, 'i>(
    scope: &mut v8::PinScope<'s, 'i>,
    source: v8::Local<'s, v8::Value>,
    _is_code_like: bool,
) -> v8::ModifyCodeGenerationFromStringsResult<'s> {
    // Calling ToString here could run guest code reentrantly. The Engine Gate
    // source contract is therefore available only for a native V8 String.
    let allowed = v8::Local::<v8::String>::try_from(source)
        .ok()
        .is_some_and(|source| decide_strings(scope, source));
    v8::ModifyCodeGenerationFromStringsResult {
        codegen_allowed: allowed,
        modified_source: None,
    }
}

unsafe extern "C" fn wasm_callback(
    context: v8::Local<v8::Context>,
    _v8_placeholder_source: v8::Local<v8::String>,
) -> bool {
    v8::callback_scope!(unsafe scope, context);
    if !guest_context(scope) {
        return false;
    }
    let stage = {
        let shared = state(scope);
        let mut shared = shared.borrow_mut();
        shared.engine_gate.record_wasm_callback();
        shared.engine_gate.staged_wasm.take()
    };
    let Some(stage) = stage else {
        return false;
    };
    let Some((source_bytes, source_sha256)) = stage.verify(scope) else {
        return false;
    };
    let reader_max_bytes = state(scope)
        .borrow()
        .remote
        .as_ref()
        .map_or(0, crate::control::RemoteControl::source_reader_max_bytes);
    let source_prefix = stage.source_prefix(reader_max_bytes);
    decide_wasm(
        scope,
        stage.request_id(),
        source_bytes,
        &source_sha256,
        source_prefix,
    )
}

fn decide_strings(scope: &mut v8::PinScope, source: v8::Local<v8::String>) -> bool {
    if !guest_context(scope) {
        return false;
    }
    let source_bytes = source.utf8_length(scope);
    if source_bytes > MAX_ENGINE_GATE_SOURCE_BYTES {
        return false;
    }
    // A lossy UTF-8 conversion would alias distinct lone-surrogate sources in
    // digest-based Host decisions. This profile admits only exact UTF-8 source.
    let mut units = Zeroizing::new(vec![0u16; source.length()]);
    source.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
    let Ok(text) = String::from_utf16(&units) else {
        return false;
    };
    let text = Zeroizing::new(text);
    debug_assert_eq!(source_bytes, text.len());
    let source_sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
    let request_id = {
        let shared = state(scope);
        shared.borrow_mut().engine_gate.next_request_id()
    };
    let Some(request_id) = request_id else {
        return false;
    };
    let limit = state(scope)
        .borrow()
        .remote
        .as_ref()
        .map_or(0, crate::control::RemoteControl::source_reader_max_bytes);
    let source_prefix =
        (limit > 0).then(|| Zeroizing::new(text.as_bytes()[..limit.min(text.len())].to_vec()));
    crate::control::decide_engine_code(
        scope,
        request_id,
        source_bytes,
        &source_sha256,
        source_prefix,
    )
}

fn decide_wasm(
    scope: &mut v8::PinScope,
    request_id: u64,
    source_bytes: usize,
    source_sha256: &str,
    source_prefix: Option<Zeroizing<Vec<u8>>>,
) -> bool {
    let request = serde_json::json!({
        "codeKind": "wasm",
        "requestId": request_id,
        "sourceBytes": source_bytes,
        "sourceSha256": source_sha256,
    })
    .to_string();
    let started = Instant::now();
    let response = state(scope)
        .borrow()
        .remote
        .as_ref()
        .and_then(|remote| remote.gate_wasm(request_id, request, source_prefix));
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
