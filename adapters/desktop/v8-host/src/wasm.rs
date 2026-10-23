//! Trusted staging for every WebAssembly BufferSource compilation entrypoint.
//!
//! Guest JavaScript never supplies metadata to the Engine Gate. This leaf
//! validates V8 internal slots without coercion, copies the exact source, and
//! retains the original value only so the native callback can reject a source
//! that changed between staging and compilation. Streaming consumes a genuine
//! bounded Runtime Response in JS, then submits its copied bytes here; it has
//! no separate Gate path or authorization shortcut.

use crate::state::{error, state};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

#[cfg(test)]
#[path = "wasm_tests.rs"]
mod tests;

pub(crate) const GENERATION: u64 = 1;

// Compilation uses background V8 work even between empty foreground turns.
// This ledger tracks liveness only; it never grants code-generation authority.
#[derive(Default)]
pub(crate) struct PendingWasmWork {
    next: u64,
    pending: HashMap<String, Instant>,
}

impl PendingWasmWork {
    pub(crate) fn active(&self) -> bool {
        !self.pending.is_empty()
    }

    fn begin(&mut self) -> Option<String> {
        if self.pending.len() >= 32 {
            return None;
        }
        self.next = self.next.checked_add(1)?;
        let token = format!("{GENERATION}:{}", self.next);
        self.pending
            .insert(token.clone(), Instant::now() + Duration::from_secs(120));
        Some(token)
    }
}

pub(crate) fn begin_async(scope: &mut v8::PinScope, mut result: v8::ReturnValue) {
    let token = state(scope).borrow_mut().wasm_work.begin();
    if let Some(token) = token {
        result.set(v8::String::new(scope, &token).unwrap().into());
    } else {
        let exception = error(scope, "WebAssembly pending operation limit exceeded");
        scope.throw_exception(exception);
    }
}

pub(crate) fn end_async(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments) {
    if let Ok(token) = v8::Local::<v8::String>::try_from(args.get(0)) {
        let token = token.to_rust_string_lossy(scope);
        state(scope).borrow_mut().wasm_work.pending.remove(&token);
    }
}

pub(crate) fn check_deadlines(scope: &mut v8::PinScope) -> Option<()> {
    if state(scope)
        .borrow()
        .wasm_work
        .pending
        .values()
        .any(|deadline| Instant::now() >= *deadline)
    {
        let exception = error(scope, "WebAssembly operation deadline exceeded");
        scope.throw_exception(exception);
        return None;
    }
    Some(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Operation {
    Module,
    Compile,
    Instantiate,
}

impl Operation {
    fn parse(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<Self> {
        if !value.is_int32() {
            return None;
        }
        Self::from_i32(value.int32_value(scope)?)
    }

    fn from_i32(value: i32) -> Option<Self> {
        match value {
            0 => Some(Self::Module),
            1 => Some(Self::Compile),
            2 => Some(Self::Instantiate),
            _ => None,
        }
    }
}

pub(crate) struct StagedWasmSource {
    generation: u64,
    request_id: u64,
    operation: Operation,
    deadline: Instant,
    source: v8::Global<v8::Value>,
    bytes: Zeroizing<Vec<u8>>,
}

impl StagedWasmSource {
    pub(crate) fn capture(
        scope: &mut v8::PinScope,
        source: v8::Local<v8::Value>,
        generation: u64,
        request_id: u64,
        operation: i32,
        timeout: Duration,
    ) -> Option<Self> {
        let operation = Operation::from_i32(operation)?;
        let bytes = Zeroizing::new(copy_source(scope, source)?);
        Some(Self {
            generation,
            request_id,
            operation,
            deadline: Instant::now().checked_add(timeout)?,
            source: v8::Global::new(scope, source),
            bytes,
        })
    }

    pub(crate) fn token(&self) -> String {
        format!("{}:{}", self.generation, self.request_id)
    }

    pub(crate) fn request_id(&self) -> u64 {
        self.request_id
    }

    pub(crate) fn source_prefix(&self, max_bytes: usize) -> Option<Zeroizing<Vec<u8>>> {
        (max_bytes > 0)
            .then(|| Zeroizing::new(self.bytes[..self.bytes.len().min(max_bytes)].to_vec()))
    }

    pub(crate) fn verify(&self, scope: &mut v8::PinScope) -> Option<(usize, String)> {
        if self.generation != GENERATION || Instant::now() >= self.deadline {
            return None;
        }
        let source = v8::Local::new(scope, &self.source);
        let current = Zeroizing::new(copy_source(scope, source)?);
        if current != self.bytes {
            return None;
        }
        debug_assert!(matches!(
            self.operation,
            Operation::Module | Operation::Compile | Operation::Instantiate
        ));
        Some((
            self.bytes.len(),
            format!("{:x}", Sha256::digest(&self.bytes)),
        ))
    }
}

fn copy_source(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<Vec<u8>> {
    // These predicates and conversions inspect V8 internal slots. They do not
    // invoke Proxy traps, accessors, @@toPrimitive, or Guest methods.
    if value.is_proxy() || value.is_shared_array_buffer() {
        return None;
    }
    if let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(value) {
        let backing = buffer.get_backing_store();
        if buffer.was_detached()
            || backing.is_shared()
            || backing.is_resizable_by_user_javascript()
            || buffer.byte_length() > crate::engine_gate::MAX_ENGINE_GATE_SOURCE_BYTES
        {
            return None;
        }
        return Some(backing.iter().map(std::cell::Cell::get).collect());
    }
    let view = v8::Local::<v8::ArrayBufferView>::try_from(value).ok()?;
    let buffer = view.buffer(scope)?;
    let backing = buffer.get_backing_store();
    if buffer.was_detached()
        || backing.is_shared()
        || backing.is_resizable_by_user_javascript()
        || view.byte_length() > crate::engine_gate::MAX_ENGINE_GATE_SOURCE_BYTES
    {
        return None;
    }
    let mut bytes = vec![0; view.byte_length()];
    (view.copy_contents(&mut bytes) == bytes.len()).then_some(bytes)
}

pub(crate) fn stage(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut result: v8::ReturnValue,
) {
    let Some(operation) = Operation::parse(scope, args.get(0)) else {
        let exception = error(scope, "Invalid WebAssembly staging operation");
        scope.throw_exception(exception);
        return;
    };
    let source = args.get(1);
    if operation == Operation::Instantiate && source.is_wasm_module_object() {
        result.set_null();
        return;
    }
    let timeout = {
        let shared = state(scope);
        shared
            .borrow()
            .remote
            .as_ref()
            .and_then(crate::control::RemoteControl::wasm_timeout)
    };
    let Some(timeout) = timeout else {
        let exception = error(scope, "WebAssembly code generation is unavailable");
        scope.throw_exception(exception);
        return;
    };
    let operation = match operation {
        Operation::Module => 0,
        Operation::Compile => 1,
        Operation::Instantiate => 2,
    };
    let token = {
        let shared = state(scope);
        shared
            .borrow_mut()
            .engine_gate
            .stage_wasm(scope, source, operation, timeout)
    };
    let Some(token) = token else {
        let exception = error(scope, "Invalid WebAssembly BufferSource");
        scope.throw_exception(exception);
        return;
    };
    result.set(v8::String::new(scope, &token).unwrap().into());
}

pub(crate) fn clear(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments) {
    let Ok(token) = v8::Local::<v8::String>::try_from(args.get(0)) else {
        return;
    };
    let token = token.to_rust_string_lossy(scope);
    state(scope).borrow_mut().engine_gate.clear_wasm(&token);
}
