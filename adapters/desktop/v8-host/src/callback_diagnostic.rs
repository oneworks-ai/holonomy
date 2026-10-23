//! Bounded, no-Guest-callback diagnostics for fatal Guest exceptions.
//!
//! The shared loop reports its own Error wrapper. Its `cause` is the original
//! thrown value, but neither value may be stringified or have `stack` read:
//! both operations can invoke Guest code during the terminal path.

use crate::state::{GuestScriptOrigin, state};

const MAX_MESSAGE_BYTES: usize = 512;
const MAX_URL_BYTES: usize = 512;
const MAX_FRAMES: usize = 8;
const MAX_SCANNED_FRAMES: usize = 32;
const FALLBACK: &str = "holo: Runtime callback failed (diagnostic unavailable)";
const UNCAUGHT_FALLBACK: &str = "Runtime execution failed (diagnostic unavailable)";
const MAX_GUEST_SCRIPT_ORIGINS: usize = 4096;

/// Register only immediately after a Host-admitted Guest source is compiled.
/// V8 script IDs increase within this isolate; if reuse/wrap is ever observed,
/// all mapped locations are disabled rather than attributing a stale ID.
pub(crate) fn register_origin(
    scope: &v8::PinScope,
    script_id: i32,
    url: &str,
    line_correction: usize,
) {
    if script_id <= 0 || !is_guest_origin(url) {
        return;
    }
    let shared = state(scope);
    let mut state = shared.borrow_mut();
    if state.guest_script_origins_disabled {
        return;
    }
    if script_id <= state.last_guest_script_id {
        state.guest_script_origins.clear();
        state.guest_script_origins_disabled = true;
        return;
    }
    state.last_guest_script_id = script_id;
    if state.guest_script_origins.len() < MAX_GUEST_SCRIPT_ORIGINS {
        state.guest_script_origins.insert(
            script_id as usize,
            GuestScriptOrigin {
                url: url.to_owned(),
                line_correction,
            },
        );
    }
}

pub(crate) fn format<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    reason: v8::Local<'s, v8::Value>,
) -> String {
    let Some(error) = own_data(scope, reason, "error") else {
        return FALLBACK.into();
    };
    let callback_wrapper = own_data(scope, reason, "code")
        .and_then(|code| v8::Local::<v8::String>::try_from(code).ok())
        .is_some_and(|code| {
            matches!(
                bounded_text(scope, code, 64).as_str(),
                "ERR_HOLONOMY_CALLBACK_FAILED" | "ERR_HOLONOMY_MICROTASK_CHECKPOINT_FAILED"
            )
        });
    let thrown = if callback_wrapper && error.is_native_error() && !error.is_proxy() {
        own_data(scope, error, "cause").unwrap_or(error)
    } else {
        error
    };
    format_thrown(
        scope,
        thrown,
        FALLBACK,
        "holo: Uncaught callback throw: ",
        "holo: Uncaught callback Error: ",
        false,
    )
}

/// Called only after execution has failed. This must not read a Guest `stack`,
/// stringify an object, or invoke any Guest descriptor/prototype hook.
pub(crate) fn format_uncaught<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    thrown: v8::Local<'s, v8::Value>,
) -> String {
    format_thrown(scope, thrown, UNCAUGHT_FALLBACK, "", "Error: ", true)
}

fn format_thrown<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    thrown: v8::Local<'s, v8::Value>,
    fallback: &str,
    string_prefix: &str,
    error_prefix: &str,
    allow_missing_message: bool,
) -> String {
    if thrown.is_proxy() {
        return fallback.into();
    }
    if let Ok(text) = v8::Local::<v8::String>::try_from(thrown) {
        return format!(
            "{string_prefix}{}",
            bounded_text(scope, text, MAX_MESSAGE_BYTES)
        );
    }
    if !thrown.is_native_error() {
        return fallback.into();
    }
    let message = match own_data_or_missing(scope, thrown, "message") {
        Some(OwnData::Value(value)) => {
            let Ok(value) = v8::Local::<v8::String>::try_from(value) else {
                return fallback.into();
            };
            Some(bounded_text(scope, value, MAX_MESSAGE_BYTES))
        }
        Some(OwnData::Missing) if allow_missing_message => None,
        _ => return fallback.into(),
    };
    let mut result = message.map_or_else(
        || error_prefix.trim_end_matches(": ").to_owned(),
        |message| format!("{error_prefix}{message}"),
    );
    // Source names and Message resource names can be replaced by a Guest
    // sourceURL, even when they look like app:// or holo-plugins://. Only the
    // V8 script ID recorded at Host compilation proves the Guest URL.
    let location = v8::Exception::create_message(scope, thrown);
    if let Some(stack) =
        v8::Exception::get_stack_trace(scope, thrown).or_else(|| location.get_stack_trace(scope))
    {
        let mut included = 0;
        for index in 0..stack.get_frame_count().min(MAX_SCANNED_FRAMES) {
            let Some(frame) = stack.get_frame(scope, index) else {
                continue;
            };
            let script_id = frame.get_script_id();
            let origin = state(scope)
                .borrow()
                .guest_script_origins
                .get(&script_id)
                .cloned();
            let Some(origin) = origin else {
                continue;
            };
            let Some(line) = frame.get_line_number().checked_sub(origin.line_correction) else {
                continue;
            };
            let column = frame.get_column();
            if line == 0 || line > 1_000_000 || column == 0 || column > 1_000_000 {
                continue;
            }
            result.push_str(&format!("\n    at {}:{line}:{column}", origin.url));
            included += 1;
            if included >= MAX_FRAMES {
                break;
            }
        }
        if included > 0 {
            return result;
        }
    }
    result
}

// V8 creates the descriptor object with its own data-valued `value` field.
// The input is rejected before the descriptor lookup if it is a Proxy, so no
// Guest getter, Proxy trap, prototype getter, or coercion is used here.
fn own_data<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    source: v8::Local<'s, v8::Value>,
    name: &str,
) -> Option<v8::Local<'s, v8::Value>> {
    match own_data_or_missing(scope, source, name)? {
        OwnData::Value(value) => Some(value),
        OwnData::Missing => None,
    }
}

enum OwnData<'s> {
    Missing,
    Value(v8::Local<'s, v8::Value>),
}

fn own_data_or_missing<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    source: v8::Local<'s, v8::Value>,
    name: &str,
) -> Option<OwnData<'s>> {
    if !source.is_object() || source.is_proxy() {
        return None;
    }
    let object = v8::Local::<v8::Object>::try_from(source).ok()?;
    let key = v8::String::new(scope, name)?;
    let descriptor = object.get_own_property_descriptor(scope, key.into())?;
    if descriptor.is_undefined() {
        return Some(OwnData::Missing);
    }
    let descriptor = v8::Local::<v8::Object>::try_from(descriptor).ok()?;
    let value_key = v8::String::new(scope, "value")?;
    if descriptor.has_own_property(scope, value_key.into()) != Some(true) {
        return None;
    }
    descriptor.get(scope, value_key.into()).map(OwnData::Value)
}

fn bounded_text(scope: &v8::PinScope, text: v8::Local<v8::String>, max_bytes: usize) -> String {
    let mut bytes = vec![0; max_bytes];
    let written = text.write_utf8_v2(scope, &mut bytes, v8::WriteFlags::kReplaceInvalidUtf8, None);
    let truncated = text.utf8_length(scope) > written;
    let mut sanitized = String::with_capacity(written + usize::from(truncated) * 3);
    for character in String::from_utf8_lossy(&bytes[..written.min(bytes.len())]).chars() {
        match character {
            '\n' => sanitized.push_str("\\n"),
            '\r' => sanitized.push_str("\\r"),
            '\t' => sanitized.push_str("\\t"),
            c if c.is_control() => sanitized.push(' '),
            c => sanitized.push(c),
        }
    }
    if truncated {
        sanitized.push_str("...");
    }
    sanitized
}

fn is_guest_origin(name: &str) -> bool {
    (name.starts_with("app://workspace/") || name.starts_with("holo-plugins:///"))
        && name.len() <= MAX_URL_BYTES
        && !name.contains("...")
        && !name.contains('\\')
        && !name.contains('?')
        && !name.contains('#')
        && !name
            .split('/')
            .any(|segment| segment == ".." || segment == ".")
}
