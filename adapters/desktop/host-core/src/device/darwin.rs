//! macOS metadata probes. No HID device is opened and no event/report, screen
//! image, identity, serial number, process name or window name is read.
use super::{DeviceSource, Sample};
use serde_json::json;
use std::{
    ffi::{c_char, c_void},
    ptr,
};

type Cf = *const c_void;
type IoObject = u32;
const UTF8: u32 = 0x0800_0100;
const CF_SINT32: i32 = 3;
const MAX_HID_SERVICES: usize = 256;
const MAX_USAGE_PAIRS: isize = 32;

#[repr(C)]
struct CgPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
struct CgSize {
    width: f64,
    height: f64,
}
#[repr(C)]
struct CgRect {
    origin: CgPoint,
    size: CgSize,
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Cf);
    fn CFGetTypeID(value: Cf) -> usize;
    fn CFDictionaryGetTypeID() -> usize;
    fn CFArrayGetTypeID() -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(value: Cf) -> u8;
    fn CFNumberGetValue(value: Cf, number_type: i32, output: *mut c_void) -> u8;
    fn CFStringCreateWithCString(allocator: Cf, value: *const c_char, encoding: u32) -> Cf;
    fn CFDictionaryGetValue(dictionary: Cf, key: Cf) -> Cf;
    fn CFArrayGetCount(array: Cf) -> isize;
    fn CFArrayGetValueAtIndex(array: Cf, index: isize) -> Cf;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> CgRect;
    fn CGDisplayRotation(display: u32) -> f64;
    fn CGDisplayCopyDisplayMode(display: u32) -> Cf;
    fn CGDisplayModeGetTypeID() -> usize;
    fn CGDisplayModeGetWidth(mode: Cf) -> usize;
    fn CGDisplayModeGetPixelWidth(mode: Cf) -> usize;
    fn CGDisplayModeGetRefreshRate(mode: Cf) -> f64;
    fn CGDisplayIsAsleep(display: u32) -> i32;
    fn CGSessionCopyCurrentDictionary() -> Cf;
}

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOServiceMatching(name: *const c_char) -> *mut c_void;
    fn IOServiceGetMatchingServices(
        main_port: u32,
        matching: *mut c_void,
        iterator: *mut IoObject,
    ) -> i32;
    fn IOIteratorNext(iterator: IoObject) -> IoObject;
    fn IOIteratorIsValid(iterator: IoObject) -> i32;
    fn IOObjectRelease(object: IoObject) -> i32;
    fn IORegistryEntryCreateCFProperty(entry: IoObject, key: Cf, allocator: Cf, options: u32)
    -> Cf;
}

unsafe extern "C" {
    fn sysctlbyname(
        name: *const c_char,
        old: *mut c_void,
        old_len: *mut usize,
        new: *mut c_void,
        new_len: usize,
    ) -> i32;
}

struct OwnedCf(Cf);
impl OwnedCf {
    fn new(raw: Cf) -> Option<Self> {
        if raw.is_null() { None } else { Some(Self(raw)) }
    }
    fn get(&self) -> Cf {
        self.0
    }
}
impl Drop for OwnedCf {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}
struct OwnedIo(IoObject);
impl Drop for OwnedIo {
    fn drop(&mut self) {
        unsafe {
            IOObjectRelease(self.0);
        }
    }
}

fn key(name: &'static [u8]) -> Option<OwnedCf> {
    let result = OwnedCf::new(unsafe {
        CFStringCreateWithCString(ptr::null(), name.as_ptr().cast(), UTF8)
    })?;
    if unsafe { CFGetTypeID(result.get()) != CFStringGetTypeID() } {
        return None;
    }
    Some(result)
}
fn number(value: Cf) -> Option<i32> {
    if value.is_null() || unsafe { CFGetTypeID(value) != CFNumberGetTypeID() } {
        return None;
    }
    let mut result = 0i32;
    if unsafe { CFNumberGetValue(value, CF_SINT32, (&mut result as *mut i32).cast()) } == 0 {
        return None;
    }
    Some(result)
}

pub(super) struct DarwinSource;
impl DeviceSource for DarwinSource {
    fn read(&mut self, operation: &str) -> Sample {
        match operation {
            "device.form-factor.read" => form_factor(),
            "device.display.read" => display(),
            "device.input.read" => input(),
            "device.lifecycle.read" => lifecycle(),
            _ => Sample::Unavailable,
        }
    }
}

fn form_factor() -> Sample {
    // A bounded model string is used only inside this function. The model
    // identifier itself never crosses the private wire.
    let mut model = [0u8; 128];
    let mut size = model.len();
    let result = unsafe {
        sysctlbyname(
            c"hw.model".as_ptr(),
            model.as_mut_ptr().cast(),
            &mut size,
            ptr::null_mut(),
            0,
        )
    };
    if result != 0 || size == 0 || size > model.len() || model[size - 1] != 0 {
        return Sample::Unavailable;
    }
    let Ok(name) = std::str::from_utf8(&model[..size - 1]) else {
        return Sample::Unavailable;
    };
    let category = if name.starts_with("Mac") || name.starts_with("VirtualMac") {
        "desktop"
    } else {
        "unknown"
    };
    Sample::Available(json!(category))
}

fn display() -> Sample {
    let display = unsafe { CGMainDisplayID() };
    if display == 0 {
        return Sample::Unavailable;
    }
    let Some(mode) = OwnedCf::new(unsafe { CGDisplayCopyDisplayMode(display) }) else {
        return Sample::Unavailable;
    };
    if unsafe { CFGetTypeID(mode.get()) != CGDisplayModeGetTypeID() } {
        return Sample::Unavailable;
    }
    let (mode_width, pixels, refresh, bounds, rotation) = unsafe {
        (
            CGDisplayModeGetWidth(mode.get()),
            CGDisplayModeGetPixelWidth(mode.get()),
            CGDisplayModeGetRefreshRate(mode.get()),
            CGDisplayBounds(display),
            CGDisplayRotation(display),
        )
    };
    let Some((width, height, scale, orientation)) = display_geometry(
        bounds.size.width,
        bounds.size.height,
        mode_width,
        pixels,
        rotation,
    ) else {
        return Sample::Unavailable;
    };
    let mut value = json!({
        "hdr":"unknown", "wideColor":"unknown", "widthCssPx":width,
        "heightCssPx":height, "scale":scale, "orientation":orientation
    });
    if refresh.is_finite() && (1.0..=1000.0).contains(&refresh) {
        value["refreshRateHz"] = json!(refresh);
    }
    Sample::Available(value)
}

fn display_geometry(
    bounds_width: f64,
    bounds_height: f64,
    mode_width: usize,
    pixels: usize,
    rotation: f64,
) -> Option<(u64, u64, f64, &'static str)> {
    // Bounds reflect the current rotation. Mode points and pixels come from
    // the same retained mode, so their ratio is a coherent scale sample.
    if !rotation.is_finite()
        || ![0.0, 90.0, 180.0, 270.0]
            .iter()
            .any(|angle| (rotation - angle).abs() < 0.5)
        || mode_width == 0
        || pixels == 0
        || !bounds_width.is_finite()
        || !bounds_height.is_finite()
        || !(1.0..=1_000_000.0).contains(&bounds_width)
        || !(1.0..=1_000_000.0).contains(&bounds_height)
        || (bounds_width - bounds_width.round()).abs() > 0.01
        || (bounds_height - bounds_height.round()).abs() > 0.01
    {
        return None;
    }
    let scale = pixels as f64 / mode_width as f64;
    if !scale.is_finite() || !(0.25..=16.0).contains(&scale) {
        return None;
    }
    let width = bounds_width.round() as u64;
    let height = bounds_height.round() as u64;
    let orientation = if width > height {
        "landscape"
    } else if width < height {
        "portrait"
    } else {
        "unknown"
    };
    Some((width, height, scale, orientation))
}

fn lifecycle() -> Sample {
    let Some(session) = OwnedCf::new(unsafe { CGSessionCopyCurrentDictionary() }) else {
        return Sample::Unavailable;
    };
    if unsafe { CFGetTypeID(session.get()) != CFDictionaryGetTypeID() } {
        return Sample::Unavailable;
    }
    // The SDK macro is CFSTR("kCGSSessionOnConsoleKey"), not its C symbol name.
    let Some(on_console_key) = key(b"kCGSSessionOnConsoleKey\0") else {
        return Sample::Unavailable;
    };
    let value = unsafe { CFDictionaryGetValue(session.get(), on_console_key.get()) };
    let interactive = if !value.is_null() && unsafe { CFGetTypeID(value) == CFBooleanGetTypeID() } {
        if unsafe { CFBooleanGetValue(value) } == 0 {
            json!(false)
        } else {
            let main = unsafe { CGMainDisplayID() };
            if main == 0 {
                json!("unknown")
            } else {
                json!(unsafe { CGDisplayIsAsleep(main) == 0 })
            }
        }
    } else {
        json!("unknown")
    };
    if interactive == "unknown" {
        return Sample::Unavailable;
    }
    Sample::Available(json!({
        "interactive":interactive, "visibility":"unknown", "memoryPressure":"unknown"
    }))
}

fn input() -> Sample {
    // IOServiceMatching transfers its dictionary to GetMatchingServices.
    let matching = unsafe { IOServiceMatching(c"IOHIDDevice".as_ptr()) };
    if matching.is_null() {
        return Sample::Unavailable;
    }
    let mut iterator = 0;
    let status = unsafe { IOServiceGetMatchingServices(0, matching, &mut iterator) };
    let _iterator = if iterator == 0 {
        None
    } else {
        Some(OwnedIo(iterator))
    };
    if status != 0 {
        return if matches!(status as u32, 0xe000_02c1 | 0xe000_02e2) {
            Sample::PermissionDenied
        } else {
            Sample::Unavailable
        };
    }
    if iterator == 0 {
        return Sample::Unavailable;
    }
    let Some(pairs_key) = key(b"DeviceUsagePairs\0") else {
        return Sample::Unavailable;
    };
    let Some(primary_page_key) = key(b"PrimaryUsagePage\0") else {
        return Sample::Unavailable;
    };
    let Some(primary_usage_key) = key(b"PrimaryUsage\0") else {
        return Sample::Unavailable;
    };
    let Some(page_key) = key(b"DeviceUsagePage\0") else {
        return Sample::Unavailable;
    };
    let Some(usage_key) = key(b"DeviceUsage\0") else {
        return Sample::Unavailable;
    };
    let mut keyboard = false;
    let mut mouse = false;
    let mut touchpad = false;
    let mut unknown_touchscreen = false;
    let mut count = 0;
    loop {
        let service = unsafe { IOIteratorNext(iterator) };
        if service == 0 {
            // IOIteratorNext also returns zero after registry mutation; this is
            // distinct from an authoritative empty, successfully read set.
            if unsafe { IOIteratorIsValid(iterator) } == 0 {
                return Sample::Unavailable;
            }
            break;
        }
        let _service = OwnedIo(service);
        count += 1;
        if count > MAX_HID_SERVICES {
            return Sample::Unavailable;
        }
        let pairs = OwnedCf::new(unsafe {
            IORegistryEntryCreateCFProperty(service, pairs_key.get(), ptr::null(), 0)
        });
        if let Some(pairs) = pairs {
            if unsafe { CFGetTypeID(pairs.get()) != CFArrayGetTypeID() } {
                return Sample::Unavailable;
            }
            let len = unsafe { CFArrayGetCount(pairs.get()) };
            if !(0..=MAX_USAGE_PAIRS).contains(&len) {
                return Sample::Unavailable;
            }
            for index in 0..len {
                let pair = unsafe { CFArrayGetValueAtIndex(pairs.get(), index) };
                if pair.is_null() || unsafe { CFGetTypeID(pair) != CFDictionaryGetTypeID() } {
                    return Sample::Unavailable;
                }
                let page = number(unsafe { CFDictionaryGetValue(pair, page_key.get()) });
                let usage = number(unsafe { CFDictionaryGetValue(pair, usage_key.get()) });
                let (Some(page), Some(usage)) = (page, usage) else {
                    return Sample::Unavailable;
                };
                categorize(
                    page,
                    usage,
                    &mut keyboard,
                    &mut mouse,
                    &mut touchpad,
                    &mut unknown_touchscreen,
                );
            }
        } else {
            let page = OwnedCf::new(unsafe {
                IORegistryEntryCreateCFProperty(service, primary_page_key.get(), ptr::null(), 0)
            });
            let usage = OwnedCf::new(unsafe {
                IORegistryEntryCreateCFProperty(service, primary_usage_key.get(), ptr::null(), 0)
            });
            let (Some(page), Some(usage)) = (page, usage) else {
                return Sample::Unavailable;
            };
            let (Some(page), Some(usage)) = (number(page.get()), number(usage.get())) else {
                return Sample::Unavailable;
            };
            categorize(
                page,
                usage,
                &mut keyboard,
                &mut mouse,
                &mut touchpad,
                &mut unknown_touchscreen,
            );
        }
    }
    // A touchpad is a fine indirect pointer, not a direct-touch screen.
    // Touch-screen metadata does not safely reveal maxTouchPoints. Never infer 1.
    if unknown_touchscreen {
        return Sample::Unavailable;
    }
    let fine = mouse || touchpad;
    Sample::Available(json!({
        "hover":fine, "keyboard":keyboard, "maxTouchPoints":0, "mouse":mouse,
        "pointer": if fine { "fine" } else { "none" }, "touch":false
    }))
}

fn categorize(
    page: i32,
    usage: i32,
    keyboard: &mut bool,
    mouse: &mut bool,
    touchpad: &mut bool,
    unknown_touchscreen: &mut bool,
) {
    if page == 1 && (usage == 6 || usage == 7) {
        *keyboard = true;
    }
    if page == 1 && usage == 2 {
        *mouse = true;
    }
    if page == 0x0d && usage == 5 {
        *touchpad = true;
    }
    if page == 0x0d && (usage == 4 || usage == 0x0c) {
        *unknown_touchscreen = true;
    }
}

#[cfg(test)]
mod tests {
    use super::{categorize, display_geometry};
    #[test]
    fn rotated_display_uses_screen_bounds_and_mode_scale() {
        let (width, height, scale, orientation) =
            display_geometry(900.0, 1440.0, 1440, 2880, 90.0).unwrap();
        assert_eq!(
            (width, height, scale, orientation),
            (900, 1440, 2.0, "portrait")
        );
        assert!(display_geometry(f64::NAN, 1440.0, 1440, 2880, 90.0).is_none());
    }

    #[test]
    fn touchpad_is_indirect_pointer_but_touchscreen_needs_contact_count() {
        let (mut keyboard, mut mouse, mut touchpad, mut unknown_screen) =
            (false, false, false, false);
        categorize(
            0x0d,
            5,
            &mut keyboard,
            &mut mouse,
            &mut touchpad,
            &mut unknown_screen,
        );
        assert!(touchpad);
        assert!(!unknown_screen);
        categorize(
            0x0d,
            4,
            &mut keyboard,
            &mut mouse,
            &mut touchpad,
            &mut unknown_screen,
        );
        assert!(unknown_screen);
    }
}
