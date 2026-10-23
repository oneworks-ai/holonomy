//! Pinned build-time v86 engine asset. This module proves the private V8
//! loading path; the VM lifecycle is owned by `host-core::v86`.
pub(crate) const V86_SOURCE: &str = include_str!("../assets/libv86.js");
pub(crate) const V86_WASM: &[u8] = include_bytes!("../assets/v86.wasm");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_v86_loads_in_node_free_rusty_v8() {
        crate::driver::initialize_engine();
        let mut isolate =
            v8::Isolate::new(v8::CreateParams::default().heap_limits(0, 256 * 1024 * 1024));
        v8::scope!(let scope, &mut isolate);
        let context = v8::Context::new(scope, Default::default());
        let scope = &mut v8::ContextScope::new(scope, context);
        let setup = v8::String::new(scope, "globalThis.module={exports:{}};globalThis.window=globalThis;globalThis.self=globalThis;globalThis.navigator={platform:'Holonomy'}").unwrap();
        v8::Script::compile(scope, setup, None)
            .unwrap()
            .run(scope)
            .unwrap();
        let shim = v8::String::new(scope, crate::v86_vm::SHIM).unwrap();
        v8::Script::compile(scope, shim, None)
            .unwrap()
            .run(scope)
            .unwrap();
        let source = v8::String::new(scope, V86_SOURCE).unwrap();
        v8::Script::compile(scope, source, None)
            .unwrap()
            .run(scope)
            .unwrap();
        let check = v8::String::new(scope, "typeof module.exports.V86 === 'function' && typeof WebAssembly.instantiate === 'function'").unwrap();
        let value = v8::Script::compile(scope, check, None)
            .unwrap()
            .run(scope)
            .unwrap();
        assert!(value.boolean_value(scope));
        assert_eq!(&V86_WASM[..4], b"\0asm");
    }
}
