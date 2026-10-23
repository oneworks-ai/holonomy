use crate::state::{error, state};
use std::io::Write;

pub fn install(scope: &mut v8::PinScope) -> Option<()> {
    let host = v8::Object::new(scope);
    for (index, name) in [
        "configuration",
        "now",
        "wakeup",
        "exit",
        "output",
        "readModule",
        "capabilityConfiguration",
        "capabilityInvokeSync",
        "capabilityInvoke",
        "capabilityInvokeImmediate",
        "capabilityAbort",
        "capabilityRelease",
        "capabilitySubscribe",
        "capabilityUnsubscribe",
        "portDispatch",
        "portCommand",
        "crypto",
        "wasmStage",
        "wasmClear",
        "wasmBeginAsync",
        "wasmEndAsync",
        "isPromise",
        "callbackDiagnostic",
    ]
    .iter()
    .enumerate()
    {
        let data = v8::Integer::new(scope, index as i32);
        let function = v8::Function::builder(dispatch)
            .data(data.into())
            .build(scope)?;
        let key = v8::String::new(scope, name)?;
        host.set(scope, key.into(), function.into())?;
    }
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "__holoNativeHost")?;
    global.set(scope, key.into(), host.into())?;
    Some(())
}

fn dispatch<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: v8::FunctionCallbackArguments<'s>,
    mut result: v8::ReturnValue,
) {
    let shared = state(scope);
    match args.data().int32_value(scope).unwrap_or(-1) {
        0 => {
            let text = shared.borrow().configuration.clone();
            result.set(v8::String::new(scope, &text).unwrap().into());
        }
        1 => result.set_double(shared.borrow().start.elapsed().as_secs_f64() * 1000.0),
        2 => {
            let deadline = if args.get(0).is_null() {
                None
            } else {
                args.get(0).number_value(scope)
            };
            if deadline.is_some_and(|d| !d.is_finite() || d < 0.0) {
                let exception = error(scope, "Invalid wakeup deadline");
                scope.throw_exception(exception);
                return;
            }
            shared.borrow_mut().wakeup = deadline;
        }
        3 => {
            shared.borrow_mut().exit_code =
                Some(args.get(0).int32_value(scope).unwrap_or(1).clamp(0, 255));
            scope.terminate_execution();
        }
        4 => {
            let stream = args.get(0).to_rust_string_lossy(scope);
            let bytes = if let Ok(view) = v8::Local::<v8::Uint8Array>::try_from(args.get(1)) {
                if view.byte_length() > 1024 * 1024 {
                    let e = error(scope, "Output limit exceeded");
                    scope.throw_exception(e);
                    return;
                }
                let mut bytes = vec![0; view.byte_length()];
                view.copy_contents(&mut bytes);
                bytes
            } else {
                args.get(1).to_rust_string_lossy(scope).into_bytes()
            };
            if bytes.len() > 1024 * 1024 {
                let e = error(scope, "Output limit exceeded");
                scope.throw_exception(e);
                return;
            }
            let mut output: Box<dyn Write> =
                if matches!(stream.as_str(), "stderr" | "error" | "warn") {
                    Box::new(std::io::stderr())
                } else {
                    Box::new(std::io::stdout())
                };
            let mut write_result = output.write_all(&bytes);
            if !matches!(stream.as_str(), "stdout" | "stderr") {
                write_result = write_result.and_then(|_| output.write_all(b"\n"));
            }
            if write_result.and_then(|_| output.flush()).is_err() {
                shared.borrow_mut().exit_code = Some(1);
                scope.terminate_execution();
            }
            result.set_bool(true);
        }
        5 => {
            let name = args.get(0).to_rust_string_lossy(scope);
            let source = shared
                .borrow_mut()
                .sources
                .as_mut()
                .ok_or_else(|| "Guest source store is unavailable".to_string())
                .and_then(|sources| sources.read(&name));
            match source {
                Ok(Some(text)) => result.set(v8::String::new(scope, &text).unwrap().into()),
                Ok(None) => result.set_null(),
                Err(message) => {
                    let exception = error(scope, &message);
                    scope.throw_exception(exception);
                }
            }
        }
        6 => {
            if shared.borrow().remote.is_none() {
                result.set_null();
                return;
            }
            if let Some(text) = crate::control::invoke(scope, "guestConfiguration", &[]) {
                result.set(v8::String::new(scope, &text).unwrap().into());
            }
        }
        7..=11 => {
            if !args.get(0).is_string()
                || args.get(0).to_rust_string_lossy(scope).len() > 1024 * 1024
            {
                let e = error(scope, "Invalid capability request");
                scope.throw_exception(e);
                return;
            }
            let request = args.get(0).to_rust_string_lossy(scope);
            let index = args.data().int32_value(scope).unwrap_or(-1);
            if index == 8 {
                let id = args.get(1).to_rust_string_lossy(scope);
                let maximum = shared
                    .borrow()
                    .remote
                    .as_ref()
                    .map_or(0, |remote| remote.request_body_reader_max_bytes());
                let maximum_base64 = 4 * maximum.div_ceil(3);
                let body = if maximum == 0 || args.get(3).is_undefined() {
                    None
                } else {
                    let Ok(value) = v8::Local::<v8::String>::try_from(args.get(3)) else {
                        let e = error(scope, "Invalid network request body transfer");
                        scope.throw_exception(e);
                        return;
                    };
                    if value.utf8_length(scope) > maximum_base64 {
                        let e = error(
                            scope,
                            "Network request body transfer exceeds selected bound",
                        );
                        scope.throw_exception(e);
                        return;
                    }
                    let text = zeroize::Zeroizing::new(value.to_rust_string_lossy(scope));
                    if !text.is_ascii() || text.len() > maximum_base64 {
                        let e = error(scope, "Invalid network request body transfer");
                        scope.throw_exception(e);
                        return;
                    }
                    Some(text)
                };
                if let Some(promise) = crate::control::invoke_async(
                    scope,
                    &request,
                    &id,
                    args.get(2).is_true(),
                    body.as_deref().map(String::as_str),
                ) {
                    result.set(promise.into());
                }
            } else {
                let name = match index {
                    7 => "invokeSync",
                    9 => "invokeImmediate",
                    10 => "abort",
                    _ => "release",
                };
                if let Some(text) = crate::control::invoke(scope, name, &[request]) {
                    result.set(v8::String::new(scope, &text).unwrap().into());
                }
            }
        }
        12 => {
            let Ok(callback) = v8::Local::<v8::Function>::try_from(args.get(1)) else {
                let e = error(scope, "Invalid resource listener");
                scope.throw_exception(e);
                return;
            };
            let id = args.get(0).to_rust_string_lossy(scope);
            if let Some(id) = crate::control::subscribe(scope, &id, callback) {
                result.set(v8::String::new(scope, &id).unwrap().into());
            }
        }
        13 => {
            let id = args.get(0).to_rust_string_lossy(scope);
            crate::control::unsubscribe(scope, &id);
        }
        14 => {
            crate::port_bridge::dispatch(scope, args);
        }
        15 => {
            let json = args.get(0).to_rust_string_lossy(scope);
            crate::port_bridge::command(scope, &json);
        }
        16 => crate::crypto::dispatch(scope, args, result),
        17 => crate::wasm::stage(scope, args, result),
        18 => crate::wasm::clear(scope, args),
        19 => crate::wasm::begin_async(scope, result),
        20 => crate::wasm::end_async(scope, args),
        21 => result.set_bool(args.get(0).is_promise()),
        22 => {
            let diagnostic = crate::callback_diagnostic::format(scope, args.get(0));
            if let Some(text) = v8::String::new(scope, &diagnostic) {
                result.set(text.into());
            }
        }
        _ => {
            let exception = error(scope, "Unknown Host operation");
            scope.throw_exception(exception);
        }
    }
}
