use super::*;
use std::{cell::RefCell, rc::Rc, time::Instant};

#[test]
fn original_v8_constructor_without_a_stage_is_denied() {
    crate::driver::initialize_engine();
    let mut isolate = v8::Isolate::new(v8::CreateParams::default());
    crate::engine_gate::install(&mut isolate);
    let state: crate::state::SharedState = Rc::new(RefCell::new(crate::state::HostState::new(
        None,
        String::new(),
        Instant::now(),
    )));
    isolate.set_slot(state);
    v8::scope!(let scope, &mut isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    crate::engine_gate::mark_guest_context(scope, context);
    v8::tc_scope!(let tc, scope);
    let source = v8::String::new(
        tc,
        "new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))",
    )
    .unwrap();
    let script = v8::Script::compile(tc, source, None).unwrap();
    assert!(script.run(tc).is_none());
    assert!(tc.has_caught());
}

#[test]
fn staged_source_is_an_immutable_generation_and_deadline_bound_snapshot() {
    crate::driver::initialize_engine();
    let mut isolate = v8::Isolate::new(v8::CreateParams::default());
    v8::scope!(let scope, &mut isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    let source = v8::String::new(
        scope,
        "globalThis.bytes=new Uint8Array([0,97,115,109,1,0,0,0]); bytes",
    )
    .unwrap();
    let script = v8::Script::compile(scope, source, None).unwrap();
    let value = script.run(scope).unwrap();

    let stage =
        StagedWasmSource::capture(scope, value, GENERATION, 7, 0, Duration::from_secs(1)).unwrap();
    assert_eq!(stage.verify(scope).unwrap().0, 8);

    let mutate = v8::String::new(scope, "bytes[0]=1").unwrap();
    v8::Script::compile(scope, mutate, None)
        .unwrap()
        .run(scope)
        .unwrap();
    assert!(stage.verify(scope).is_none());

    let wrong_generation =
        StagedWasmSource::capture(scope, value, GENERATION + 1, 8, 1, Duration::from_secs(1))
            .unwrap();
    assert!(wrong_generation.verify(scope).is_none());
    let expired =
        StagedWasmSource::capture(scope, value, GENERATION, 9, 2, Duration::ZERO).unwrap();
    assert!(expired.verify(scope).is_none());
}

#[test]
fn buffer_source_validation_uses_internal_slots_without_guest_callbacks() {
    crate::driver::initialize_engine();
    let mut isolate = v8::Isolate::new(v8::CreateParams::default());
    v8::scope!(let scope, &mut isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    let source = v8::String::new(
        scope,
        r#"
        globalThis.sideEffects=0;
        const trap=()=>{sideEffects++;throw new Error('trap')};
        const detachedBuffer=new ArrayBuffer(8), detached=new Uint8Array(detachedBuffer);
        detachedBuffer.transfer();
        const valid=new Uint8Array([9,0,97,115,109,1,0,0,0,9]).subarray(1,9);
        Object.defineProperty(valid,'byteLength',{get:trap});
        Object.defineProperty(valid,'buffer',{get:trap});
        [valid,new Proxy(new Uint8Array(8),{get:trap,getPrototypeOf:trap}),
         new Uint8Array(new SharedArrayBuffer(8)),
         new Uint8Array(new ArrayBuffer(8,{maxByteLength:16})),detached,{valueOf:trap}]
      "#,
    )
    .unwrap();
    let values = v8::Local::<v8::Array>::try_from(
        v8::Script::compile(scope, source, None)
            .unwrap()
            .run(scope)
            .unwrap(),
    )
    .unwrap();
    let valid = values.get_index(scope, 0).unwrap();
    assert_eq!(copy_source(scope, valid).unwrap().len(), 8);
    for index in 1..values.length() {
        let value = values.get_index(scope, index).unwrap();
        assert!(copy_source(scope, value).is_none(), "index {index}");
    }
    let key = v8::String::new(scope, "sideEffects").unwrap();
    assert_eq!(
        context
            .global(scope)
            .get(scope, key.into())
            .unwrap()
            .int32_value(scope),
        Some(0)
    );
}
