use super::*;

#[test]
fn native_snapshot_uses_internal_slots_without_guest_callbacks() {
    crate::driver::initialize_engine();
    let mut isolate = v8::Isolate::new(v8::CreateParams::default());
    v8::scope!(let scope, &mut isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    let source = v8::String::new(scope, r#"
      globalThis.sideEffects=0;
      const trap=()=>{sideEffects++;throw new Error('trap')};
      const revoked=Proxy.revocable(new Uint8Array(1),{}); revoked.revoke();
      const backing=new ArrayBuffer(1), detached=new Uint8Array(backing); backing.transfer();
      const valid=new Uint8Array([9,1,2,9]).subarray(1,3);
      Object.defineProperty(valid,'byteLength',{get:trap});
      Object.defineProperty(valid,'buffer',{get:trap});
      Object.defineProperty(valid,'constructor',{get:trap});
      [valid,new Proxy(new Uint8Array(1),{get:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap}),
       revoked.proxy,new Uint8Array(new SharedArrayBuffer(1)),
       new Uint8Array(new ArrayBuffer(1,{maxByteLength:2})),detached,new Uint16Array(1),
       {valueOf:trap,toString:trap}]
    "#).unwrap();
    let script = v8::Script::compile(scope, source, None).unwrap();
    let value = script.run(scope).unwrap();
    let values = v8::Local::<v8::Array>::try_from(value).unwrap();
    let valid = values.get_index(scope, 0).unwrap();
    assert_eq!(bytes(scope, valid, 2).unwrap().as_slice(), &[1, 2]);
    assert!(bytes(scope, valid, 1).is_err());
    for index in 1..values.length() {
        let invalid = values.get_index(scope, index).unwrap();
        assert!(bytes(scope, invalid, 16).is_err(), "index {index}");
        assert!(number(scope, invalid).is_err());
    }
    let key = v8::String::new(scope, "sideEffects").unwrap();
    let count = context.global(scope).get(scope, key.into()).unwrap();
    assert_eq!(count.int32_value(scope), Some(0));
    let result = output(scope, &[3, 4]).unwrap();
    assert_eq!(bytes(scope, result, 2).unwrap().as_slice(), &[3, 4]);
}
