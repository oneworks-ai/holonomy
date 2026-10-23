use super::protocol::{ControlFailure, ControlValue};

pub(super) enum Snapshot {
    Deferred,
    Complete(Result<ControlValue, ControlFailure>, usize),
}

/// Inspect native V8 types before copying; never stringify an arbitrary value.
pub(super) fn snapshot(
    scope: &mut v8::PinScope,
    value: v8::Local<v8::Value>,
    allow_undefined: bool,
    message_limit: usize,
    available_bytes: usize,
) -> Snapshot {
    if let Ok(text) = v8::Local::<v8::String>::try_from(value) {
        let size = text.utf8_length(scope);
        if size > message_limit {
            Snapshot::Complete(Err(ControlFailure::ResultLimit), 0)
        } else if size > available_bytes {
            Snapshot::Deferred
        } else {
            Snapshot::Complete(
                Ok(ControlValue::Text(text.to_rust_string_lossy(scope))),
                size,
            )
        }
    } else if allow_undefined && value.is_undefined() {
        Snapshot::Complete(Ok(ControlValue::Undefined), 0)
    } else {
        Snapshot::Complete(Err(ControlFailure::InvalidResult), 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_is_bounded_and_never_coerces_host_values_or_errors() {
        crate::driver::initialize_engine();
        let mut isolate = v8::Isolate::new(v8::CreateParams::default());
        v8::scope!(let scope, &mut isolate);
        let context = v8::Context::new(scope, Default::default());
        let scope = &mut v8::ContextScope::new(scope, context);
        let source = v8::String::new(scope, r#"
            globalThis.calls=0;
            const getter=()=>{calls++;throw Error('secret')};
            const value={get toString(){return getter()},get then(){return getter()}};
            [value,new Proxy(value,{get:getter,getPrototypeOf:getter}),new Error('host-secret'),1,null]
        "#).unwrap();
        let script = v8::Script::compile(scope, source, None).unwrap();
        let values = v8::Local::<v8::Array>::try_from(script.run(scope).unwrap()).unwrap();
        for index in 0..values.length() {
            let value = values.get_index(scope, index).unwrap();
            assert!(matches!(
                snapshot(scope, value, true, 8, 8),
                Snapshot::Complete(Err(ControlFailure::InvalidResult), 0)
            ));
        }
        let name = v8::String::new(scope, "calls").unwrap();
        let calls = context.global(scope).get(scope, name.into()).unwrap();
        assert_eq!(calls.int32_value(scope), Some(0));
        let text = v8::String::new(scope, "abcd").unwrap();
        assert!(matches!(
            snapshot(scope, text.into(), false, 3, 8),
            Snapshot::Complete(Err(ControlFailure::ResultLimit), 0)
        ));
        assert!(matches!(
            snapshot(scope, text.into(), false, 8, 3),
            Snapshot::Deferred
        ));
        assert!(
            matches!(snapshot(scope, text.into(), false, 8, 4), Snapshot::Complete(Ok(ControlValue::Text(text)),4) if text=="abcd")
        );
        let value = v8::undefined(scope);
        assert!(matches!(
            snapshot(scope, value.into(), true, 8, 8),
            Snapshot::Complete(Ok(ControlValue::Undefined), 0)
        ));
        assert!(matches!(
            snapshot(scope, value.into(), false, 8, 8),
            Snapshot::Complete(Err(ControlFailure::InvalidResult), 0)
        ));
    }
}
