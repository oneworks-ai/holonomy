//! Private, synchronous binary intrinsic. No property getters, coercion or Guest reentry.
use crate::state::{error, state};
use holonomy_desktop_host::crypto::{self, Bytes, CryptoResult, INVALID};
#[cfg(test)]
#[path = "crypto_tests.rs"]
mod tests;

fn number(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> CryptoResult<u32> {
    if !value.is_uint32() {
        return Err(INVALID);
    }
    value.uint32_value(scope).ok_or(INVALID)
}

fn bytes(scope: &mut v8::PinScope, value: v8::Local<v8::Value>, cap: usize) -> CryptoResult<Bytes> {
    // IsProxy/type/internal-slot operations never execute Proxy traps or JS methods.
    if value.is_proxy() {
        return Err(INVALID);
    }
    let view = v8::Local::<v8::Uint8Array>::try_from(value).map_err(|_| INVALID)?;
    let buffer = view.buffer(scope).ok_or(INVALID)?;
    let backing = buffer.get_backing_store();
    if buffer.was_detached()
        || backing.is_shared()
        || backing.is_resizable_by_user_javascript()
        || view.byte_length() > cap
    {
        return Err(INVALID);
    }
    let mut copy = Bytes::new(vec![0; view.byte_length()]);
    if view.copy_contents(&mut copy) != copy.len() {
        return Err(INVALID);
    }
    Ok(copy)
}

fn output<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bytes: &[u8],
) -> CryptoResult<v8::Local<'s, v8::Value>> {
    // Allocate through V8 (including its sandbox allocator), not a raw Rust pointer.
    let backing = v8::ArrayBuffer::new_backing_store(scope, bytes.len());
    for (target, byte) in backing.iter().zip(bytes) {
        target.set(*byte);
    }
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &backing.make_shared());
    Ok(v8::Uint8Array::new(scope, buffer, 0, bytes.len())
        .ok_or(INVALID)?
        .into())
}

fn field(
    scope: &mut v8::PinScope,
    object: v8::Local<v8::Object>,
    name: &str,
    value: v8::Local<v8::Value>,
) -> CryptoResult<()> {
    let key = v8::String::new(scope, name).ok_or(INVALID)?;
    if object.create_data_property(scope, key.into(), value) == Some(true) {
        Ok(())
    } else {
        Err(INVALID)
    }
}

fn invoke<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: &v8::FunctionCallbackArguments,
) -> CryptoResult<v8::Local<'s, v8::Value>> {
    let shared = state(scope);
    let operation = number(scope, args.get(0))?;
    let mut crypto = shared.borrow_mut();
    let crypto = &mut crypto.crypto;
    match operation {
        0 => {
            let kind = number(scope, args.get(1))?;
            let key = bytes(scope, args.get(2), crypto::MAX_KEY)?;
            let iv = bytes(scope, args.get(3), 12)?;
            let id = crypto.create(kind, &key, &iv)?;
            Ok(v8::Integer::new_from_unsigned(scope, id).into())
        }
        1..=5 | 8 => {
            let id = number(scope, args.get(1))?;
            match operation {
                1 => {
                    let data = bytes(scope, args.get(2), crypto::MAX_UPDATE)?;
                    crypto.update(id, &data)?;
                    output(scope, &[])
                }
                2 => output(scope, &crypto.digest(id)?),
                3 => {
                    let data = bytes(scope, args.get(2), crypto::MAX_AAD)?;
                    crypto.set_aad(id, &data)?;
                    Ok(v8::undefined(scope).into())
                }
                4 => {
                    let data = bytes(scope, args.get(2), 16)?;
                    crypto.set_auth_tag(id, &data)?;
                    Ok(v8::undefined(scope).into())
                }
                5 => {
                    let result = crypto.final_context(id)?;
                    let object = v8::Object::new(scope);
                    let data = output(scope, &result.output)?;
                    field(scope, object, "output", data)?;
                    if let Some(tag) = result.auth_tag {
                        let tag = output(scope, &tag)?;
                        field(scope, object, "authTag", tag)?;
                    }
                    if let Some(authenticated) = result.authenticated {
                        let value = v8::Boolean::new(scope, authenticated);
                        field(scope, object, "authenticated", value.into())?;
                    }
                    Ok(object.into())
                }
                _ => {
                    crypto.dispose_context(id);
                    Ok(v8::undefined(scope).into())
                }
            }
        }
        6 => {
            let size = number(scope, args.get(1))? as usize;
            output(scope, &crypto.random(size)?)
        }
        7 => {
            let left = bytes(scope, args.get(1), crypto::MAX_COMPARE)?;
            let right = bytes(scope, args.get(2), crypto::MAX_COMPARE)?;
            Ok(v8::Boolean::new(scope, crypto.equal(&left, &right)?).into())
        }
        9 => {
            crypto.dispose();
            Ok(v8::undefined(scope).into())
        }
        _ => Err(INVALID),
    }
}

pub fn dispatch(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut result: v8::ReturnValue,
) {
    match invoke(scope, &args) {
        Ok(value) => result.set(value),
        Err(_) => {
            // Shared CryptoPrimitivePort owns stable public error translation.
            let exception = error(scope, INVALID);
            scope.throw_exception(exception);
        }
    }
}
