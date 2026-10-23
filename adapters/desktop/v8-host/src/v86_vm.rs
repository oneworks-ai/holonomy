//! Node-free v86 engine in a private rusty_v8 isolate. The caller must run it
//! on one owning thread; the Host worker can later route VM commands here.
use holonomy_desktop_host::v86::{
    EnginePoll, SerialChunk, VerifiedArtifacts, VmEngine, VmError, VmStatus,
};
use ring::rand::{SecureRandom, SystemRandom};
use std::ops::{Deref, DerefMut};

pub(crate) const SHIM: &str = include_str!("../assets/v86-shim.js");
const BOOTSTRAP: &str = include_str!("../assets/v86-bootstrap.js");
const NETWORK: &str = include_str!("../assets/v86-network.js");
const WEB_STANDARDS: &str = include_str!("../generated/v86-web-standards.js");

pub(crate) struct V8VmEngine;

// OwnedIsolate enters on creation and requires entered LIFO disposal. VM
// environments instead interleave and close in arbitrary order on one owner
// thread. Keep each isolate exited between calls and balance every entry.
struct VmIsolate {
    owned: v8::OwnedIsolate,
}

impl VmIsolate {
    fn new(params: v8::CreateParams) -> Self {
        let owned = v8::Isolate::new(params);
        // SAFETY: the newly created isolate is current on this owner thread.
        unsafe { owned.exit() };
        Self { owned }
    }

    fn enter(&mut self) -> EnteredVmIsolate<'_> {
        // SAFETY: VM handles never leave the VM owner thread. The guard holds
        // the exclusive borrow and exits before another method can use it.
        unsafe { self.owned.enter() };
        EnteredVmIsolate {
            isolate: &mut self.owned,
        }
    }
}

impl Drop for VmIsolate {
    fn drop(&mut self) {
        // SAFETY: no entry guard can outlive its exclusive borrow. Restore the
        // one entry OwnedIsolate::drop expects; its field Drop performs exit.
        unsafe { self.owned.enter() };
    }
}

struct EnteredVmIsolate<'a> {
    isolate: &'a mut v8::OwnedIsolate,
}

impl Deref for EnteredVmIsolate<'_> {
    type Target = v8::OwnedIsolate;
    fn deref(&self) -> &Self::Target {
        self.isolate
    }
}

impl DerefMut for EnteredVmIsolate<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.isolate
    }
}

impl Drop for EnteredVmIsolate<'_> {
    fn drop(&mut self) {
        // SAFETY: only private VM scopes run inside this guard and all of them
        // are destroyed first, including on an early return or unwind.
        unsafe { self.isolate.exit() };
    }
}

pub(crate) struct V8VmHandle {
    isolate: VmIsolate,
    context: Option<v8::Global<v8::Context>>,
}

impl V8VmHandle {
    fn with_context<T>(
        &mut self,
        action: impl FnOnce(&mut v8::PinScope) -> Result<T, VmError>,
    ) -> Result<T, VmError> {
        let context = self.context.as_ref().ok_or(VmError::Engine)?;
        let mut entered = self.isolate.enter();
        v8::scope!(let scope, &mut *entered);
        let context = v8::Local::new(scope, context);
        let scope = &mut v8::ContextScope::new(scope, context);
        action(scope)
    }
}

impl Drop for V8VmHandle {
    fn drop(&mut self) {
        let _entered = self.isolate.enter();
        // Reset the persistent Context while its isolate is still alive and
        // current. The exited isolate is disposed by VmIsolate's field Drop.
        drop(self.context.take());
    }
}

fn run(scope: &mut v8::PinScope, source: &str) -> Result<(), VmError> {
    let source = v8::String::new(scope, source).ok_or(VmError::Engine)?;
    v8::Script::compile(scope, source, None)
        .ok_or(VmError::Engine)?
        .run(scope)
        .ok_or(VmError::Engine)?;
    Ok(())
}

fn property<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
) -> Result<v8::Local<'s, v8::Value>, VmError> {
    let key = v8::String::new(scope, name).ok_or(VmError::Engine)?;
    scope
        .get_current_context()
        .global(scope)
        .get(scope, key.into())
        .ok_or(VmError::Engine)
}

fn call<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
    args: &[v8::Local<v8::Value>],
) -> Result<v8::Local<'s, v8::Value>, VmError> {
    let function =
        v8::Local::<v8::Function>::try_from(property(scope, name)?).map_err(|_| VmError::Engine)?;
    let global = scope.get_current_context().global(scope);
    function
        .call(scope, global.into(), args)
        .ok_or(VmError::Engine)
}

fn set_value(
    scope: &mut v8::PinScope,
    name: &str,
    value: v8::Local<v8::Value>,
) -> Result<(), VmError> {
    let key = v8::String::new(scope, name).ok_or(VmError::Engine)?;
    let global = scope.get_current_context().global(scope);
    if global.set(scope, key.into(), value) == Some(true) {
        Ok(())
    } else {
        Err(VmError::Engine)
    }
}

fn set_bytes(scope: &mut v8::PinScope, name: &str, bytes: &[u8]) -> Result<(), VmError> {
    let backing = v8::ArrayBuffer::new_backing_store(scope, bytes.len());
    for (target, byte) in backing.iter().zip(bytes) {
        target.set(*byte);
    }
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &backing.make_shared());
    set_value(scope, name, buffer.into())
}

fn secure_random(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut result: v8::ReturnValue,
) {
    let input = args.get(0);
    if !(input.is_uint8_array()
        || input.is_uint8_clamped_array()
        || input.is_int8_array()
        || input.is_uint16_array()
        || input.is_int16_array()
        || input.is_uint32_array()
        || input.is_int32_array())
    {
        scope.throw_exception(v8::Exception::type_error(
            scope,
            v8::String::new(scope, "Expected integer TypedArray").unwrap(),
        ));
        return;
    }
    let Ok(view) = v8::Local::<v8::TypedArray>::try_from(input) else {
        scope.throw_exception(v8::Exception::type_error(
            scope,
            v8::String::new(scope, "Invalid random buffer").unwrap(),
        ));
        return;
    };
    let Some(backing) = view.get_backing_store() else {
        scope.throw_exception(v8::Exception::type_error(
            scope,
            v8::String::new(scope, "Invalid random buffer").unwrap(),
        ));
        return;
    };
    if view.byte_length() > 65536
        || backing.is_shared()
        || backing.is_resizable_by_user_javascript()
    {
        scope.throw_exception(v8::Exception::type_error(
            scope,
            v8::String::new(scope, "Invalid random buffer").unwrap(),
        ));
        return;
    }
    if view.byte_length() == 0 {
        result.set(input);
        return;
    }
    let mut random = vec![0; view.byte_length()];
    if SystemRandom::new().fill(&mut random).is_err() {
        scope.throw_exception(v8::Exception::error(
            scope,
            v8::String::new(scope, "Random unavailable").unwrap(),
        ));
        return;
    }
    // No JS runs between checking the view and copying into its backing store.
    unsafe {
        std::ptr::copy_nonoverlapping(random.as_ptr(), view.data().cast::<u8>(), random.len());
    }
    result.set(args.get(0));
}

impl V8VmEngine {
    fn open_vm(
        memory_bytes: u64,
        artifacts: &VerifiedArtifacts,
        network_enabled: bool,
    ) -> Result<V8VmHandle, VmError> {
        crate::driver::initialize_engine();
        let mut isolate =
            VmIsolate::new(v8::CreateParams::default().heap_limits(0, 128 * 1024 * 1024));
        let context = {
            let mut entered = isolate.enter();
            entered.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
            v8::scope!(let scope, &mut *entered);
            let context = v8::Context::new(scope, Default::default());
            let scope = &mut v8::ContextScope::new(scope, context);
            let random = v8::Function::builder(secure_random)
                .build(scope)
                .ok_or(VmError::Engine)?;
            set_value(scope, "__holoSecureRandom", random.into())?;
            run(
                scope,
                "globalThis.module={exports:{}};globalThis.window=globalThis;globalThis.self=globalThis;globalThis.navigator={platform:'Holonomy'}",
            )?;
            run(scope, SHIM)?;
            if network_enabled {
                run(scope, WEB_STANDARDS)?;
                run(scope, NETWORK)?;
            }
            run(scope, crate::v86_probe::V86_SOURCE)?;
            set_bytes(scope, "__holoBios", artifacts.bios())?;
            set_bytes(scope, "__holoKernel", artifacts.kernel())?;
            set_bytes(scope, "__holoInitrd", artifacts.initrd())?;
            set_bytes(scope, "__holoWasm", crate::v86_probe::V86_WASM)?;
            let memory = v8::Number::new(scope, memory_bytes as f64);
            set_value(scope, "__holoMemoryBytes", memory.into())?;
            let network = v8::Boolean::new(scope, network_enabled);
            set_value(scope, "__holoNetworkEnabled", network.into())?;
            run(scope, BOOTSTRAP)?;
            v8::Global::new(scope, context)
        };
        Ok(V8VmHandle {
            isolate,
            context: Some(context),
        })
    }
}

impl VmEngine for V8VmEngine {
    type Handle = V8VmHandle;

    fn open(
        &mut self,
        memory_bytes: u64,
        artifacts: &VerifiedArtifacts,
    ) -> Result<Self::Handle, VmError> {
        Self::open_vm(memory_bytes, artifacts, false)
    }

    fn open_with_network(
        &mut self,
        memory_bytes: u64,
        artifacts: &VerifiedArtifacts,
        enabled: bool,
    ) -> Result<Self::Handle, VmError> {
        Self::open_vm(memory_bytes, artifacts, enabled)
    }

    fn start(&mut self, handle: &mut Self::Handle) -> Result<(), VmError> {
        handle.with_context(|scope| {
            call(scope, "__holoVmStart", &[])?;
            scope.perform_microtask_checkpoint();
            Ok(())
        })
    }

    fn serial_write(&mut self, handle: &mut Self::Handle, bytes: &[u8]) -> Result<(), VmError> {
        handle.with_context(|scope| {
            let backing = v8::ArrayBuffer::new_backing_store(scope, bytes.len());
            for (target, byte) in backing.iter().zip(bytes) {
                target.set(*byte);
            }
            let buffer = v8::ArrayBuffer::with_backing_store(scope, &backing.make_shared());
            let view = v8::Uint8Array::new(scope, buffer, 0, bytes.len()).ok_or(VmError::Engine)?;
            set_value(scope, "__holoPendingWrite", view.into())?;
            call(scope, "__holoVmWrite", &[])?;
            Ok(())
        })
    }

    fn network_drain(
        &mut self,
        handle: &mut Self::Handle,
        limit: usize,
    ) -> Result<String, VmError> {
        handle.with_context(|scope| {
            let limit = v8::Integer::new_from_unsigned(scope, limit as u32);
            let value = call(scope, "__holoVmNetworkDrain", &[limit.into()])?;
            let value = v8::Local::<v8::String>::try_from(value).map_err(|_| VmError::Engine)?;
            let text = value.to_rust_string_lossy(scope);
            if text.len() > 128 * 1024 {
                return Err(VmError::Limit);
            }
            Ok(text)
        })
    }

    fn network_deliver(&mut self, handle: &mut Self::Handle, input: &str) -> Result<(), VmError> {
        handle.with_context(|scope| {
            let input = v8::String::new(scope, input).ok_or(VmError::Engine)?;
            call(scope, "__holoVmNetworkDeliver", &[input.into()])?;
            scope.perform_microtask_checkpoint();
            Ok(())
        })
    }

    fn poll(&mut self, handle: &mut Self::Handle, max_bytes: usize) -> Result<EnginePoll, VmError> {
        handle.with_context(|scope| {
            // One Host turn may not drain an indefinitely self-scheduling VM queue.
            for _ in 0..64 {
                if !v8::Platform::pump_message_loop(&v8::V8::get_current_platform(), scope, false) {
                    break;
                }
            }
            scope.perform_microtask_checkpoint();
            let maximum = v8::Integer::new_from_unsigned(scope, max_bytes.min(65536) as u32);
            let result = call(scope, "__holoVmPoll", &[maximum.into()])?;
            let object = v8::Local::<v8::Object>::try_from(result).map_err(|_| VmError::Engine)?;
            let status_key = v8::String::new(scope, "status").ok_or(VmError::Engine)?;
            let status = object
                .get(scope, status_key.into())
                .ok_or(VmError::Engine)?
                .to_rust_string_lossy(scope);
            let bytes_key = v8::String::new(scope, "bytes").ok_or(VmError::Engine)?;
            let view = v8::Local::<v8::Uint8Array>::try_from(
                object.get(scope, bytes_key.into()).ok_or(VmError::Engine)?,
            )
            .map_err(|_| VmError::Engine)?;
            if view.byte_length() > max_bytes {
                return Err(VmError::Limit);
            }
            let mut bytes = vec![0; view.byte_length()];
            if view.copy_contents(&mut bytes) != bytes.len() {
                return Err(VmError::Engine);
            }
            let status = match status.as_str() {
                "running" => VmStatus::Running,
                "stopped" => VmStatus::Stopped,
                "failed" => VmStatus::Failed,
                _ => return Err(VmError::Engine),
            };
            Ok(EnginePoll {
                status,
                chunks: if bytes.is_empty() {
                    Vec::new()
                } else {
                    vec![SerialChunk { uart: 1, bytes }]
                },
            })
        })
    }

    fn close(&mut self, mut handle: Self::Handle) {
        let _ = handle.with_context(|scope| call(scope, "__holoVmClose", &[]).map(|_| ()));
        // Teardown must not run an arbitrary Promise continuation. Dropping the
        // private isolate releases its V8-owned VM state after this scope.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_vm(byte: u8) -> V8VmHandle {
        crate::driver::initialize_engine();
        let mut isolate = VmIsolate::new(v8::CreateParams::default());
        let context = {
            let mut entered = isolate.enter();
            entered.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
            v8::scope!(let scope, &mut *entered);
            let context = v8::Context::new(scope, Default::default());
            let scope = &mut v8::ContextScope::new(scope, context);
            run(
                scope,
                &format!(
                    "globalThis.__holoVmStart=()=>{{}};globalThis.__holoVmClose=()=>{{}};\
                 globalThis.__holoVmPoll=()=>({{status:'running',bytes:new Uint8Array([{byte}])}})"
                ),
            )
            .unwrap();
            v8::Global::new(scope, context)
        };
        V8VmHandle {
            isolate,
            context: Some(context),
        }
    }

    #[test]
    fn vm_handles_interleave_and_close_in_non_creation_order() {
        let mut engine = V8VmEngine;
        let mut first = tiny_vm(b'A');
        let mut second = tiny_vm(b'B');
        engine.start(&mut first).unwrap();
        assert_eq!(engine.poll(&mut first, 64).unwrap().chunks[0].bytes, b"A");
        engine.start(&mut second).unwrap();
        assert_eq!(engine.poll(&mut second, 64).unwrap().chunks[0].bytes, b"B");
        engine.close(first);
        let mut third = tiny_vm(b'C');
        engine.close(second);
        engine.start(&mut third).unwrap();
        assert_eq!(engine.poll(&mut third, 64).unwrap().chunks[0].bytes, b"C");
        engine.close(third);
    }

    #[test]
    fn failed_vm_call_restores_the_other_vm_context_before_teardown() {
        let mut engine = V8VmEngine;
        let mut first = tiny_vm(b'A');
        let mut second = tiny_vm(b'B');
        let result: Result<(), VmError> = first.with_context(|_| Err(VmError::Engine));
        assert!(matches!(result, Err(VmError::Engine)));
        // The failed VM is not resumed; another VM must still select its own
        // Context, and closing the failed older handle must not corrupt it.
        engine.start(&mut second).unwrap();
        assert_eq!(engine.poll(&mut second, 64).unwrap().chunks[0].bytes, b"B");
        engine.close(first);
        assert_eq!(engine.poll(&mut second, 64).unwrap().chunks[0].bytes, b"B");
        engine.close(second);
    }
}
