use super::{
    protocol::{ControlValue, MAX_MESSAGE_BYTES},
    value::{Snapshot, snapshot},
};
use crate::state::{call, state};
pub(super) fn handles(
    scope: &v8::PinScope,
) -> Option<(v8::Global<v8::Context>, v8::Global<v8::Object>)> {
    let shared = state(scope);
    let state = shared.borrow();
    let control = state.control.as_ref()?;
    Some((
        control.context.as_ref()?.clone(),
        control.api.as_ref()?.clone(),
    ))
}

pub(super) fn invoke_host(
    scope: &mut v8::PinScope,
    name: &str,
    arguments: &[String],
) -> Option<String> {
    let (context, api) = handles(scope)?;
    {
        let context = v8::Local::new(scope, context);
        let scope = &mut v8::ContextScope::new(scope, context);
        v8::tc_scope!(let tc,scope);
        let response = (|| {
            let api = v8::Local::new(tc, api);
            let arguments = arguments
                .iter()
                .map(|value| v8::String::new(tc, value).map(Into::into))
                .collect::<Option<Vec<_>>>()?;
            let result = call(tc, api, name, &arguments)?;
            match snapshot(tc, result, true, MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES) {
                Snapshot::Complete(Ok(ControlValue::Text(text)), _) => Some(text),
                Snapshot::Complete(Ok(ControlValue::Undefined), _) => Some(String::new()),
                _ => None,
            }
        })();
        if response.is_none() {
            tc.reset();
        }
        response
    }
}

pub fn invoke_promise(
    scope: &mut v8::PinScope,
    name: &str,
    arguments: &[String],
) -> Option<v8::Global<v8::Promise>> {
    invoke_promise_with_bytes(scope, name, arguments, None)
}

pub(super) fn invoke_gate_promise(
    scope: &mut v8::PinScope,
    encoded: &str,
    source_prefix: Option<&[u8]>,
) -> Option<v8::Global<v8::Promise>> {
    invoke_promise_with_bytes(
        scope,
        "gateEngineCode",
        &[encoded.to_owned()],
        source_prefix,
    )
}

fn invoke_promise_with_bytes(
    scope: &mut v8::PinScope,
    name: &str,
    arguments: &[String],
    source_prefix: Option<&[u8]>,
) -> Option<v8::Global<v8::Promise>> {
    let (context, api) = handles(scope)?;
    {
        let context = v8::Local::new(scope, context);
        let scope = &mut v8::ContextScope::new(scope, context);
        v8::tc_scope!(let tc,scope);
        let response = (|| {
            let api = v8::Local::new(tc, api);
            let mut arguments = arguments
                .iter()
                .map(|value| v8::String::new(tc, value).map(Into::into))
                .collect::<Option<Vec<_>>>()?;
            if let Some(prefix) = source_prefix {
                // The only V8 copy is owned by the Host Context. Rust's queued
                // prefix is zeroized when this command leaves the worker.
                let backing = v8::ArrayBuffer::new_backing_store(tc, prefix.len());
                for (target, byte) in backing.iter().zip(prefix) {
                    target.set(*byte);
                }
                let buffer = v8::ArrayBuffer::with_backing_store(tc, &backing.make_shared());
                arguments.push(v8::Uint8Array::new(tc, buffer, 0, prefix.len())?.into());
            }
            let result = call(tc, api, name, &arguments)?;
            let promise = v8::Local::<v8::Promise>::try_from(result).ok()?;
            crate::rejection::handle(tc, promise);
            Some(v8::Global::new(tc, promise))
        })();
        if response.is_none() {
            tc.reset();
        }
        response
    }
}
pub(super) fn invoke_async_host(
    scope: &mut v8::PinScope,
    json: &str,
    cancellation_id: &str,
    aborted: bool,
    network_request_body_base64: Option<&str>,
) -> Option<v8::Global<v8::Promise>> {
    let (host_context, api) = handles(scope)?;
    {
        let context = v8::Local::new(scope, host_context);
        let scope = &mut v8::ContextScope::new(scope, context);
        v8::tc_scope!(let tc, scope);
        let result = (|| {
            let api = v8::Local::new(tc, api);
            let json = v8::String::new(tc, json)?;
            let cancellation = v8::String::new(tc, cancellation_id)?;
            let aborted = v8::Boolean::new(tc, aborted);
            let mut arguments = vec![json.into(), cancellation.into(), aborted.into()];
            if let Some(body) = network_request_body_base64 {
                arguments.push(v8::String::new(tc, body)?.into());
            }
            let result = call(tc, api, "invoke", &arguments)?;
            let promise = v8::Local::<v8::Promise>::try_from(result).ok()?;
            crate::rejection::handle(tc, promise);
            Some(v8::Global::new(tc, promise))
        })();
        if result.is_none() {
            tc.reset();
        }
        result
    }
}
