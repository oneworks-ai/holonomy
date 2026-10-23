use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

struct MockSource {
    queries: Arc<AtomicUsize>,
    display: Vec<Sample>,
}
impl DeviceSource for MockSource {
    fn read(&mut self, operation: &str) -> Sample {
        let index = self.queries.fetch_add(1, Ordering::SeqCst);
        if operation == "device.display.read" {
            self.display
                .get(index)
                .cloned()
                .unwrap_or(Sample::Unavailable)
        } else {
            Sample::Unavailable
        }
    }
}

fn host(display: Vec<Sample>) -> (NativeDevice, Arc<AtomicUsize>) {
    let queries = Arc::new(AtomicUsize::new(0));
    (
        NativeDevice {
            selected: true,
            closed: false,
            policy: None,
            source: Box::new(MockSource {
                queries: queries.clone(),
                display,
            }),
            cache: BTreeMap::new(),
        },
        queries,
    )
}
fn policy(operations: Value) -> String {
    json!({"schemaVersion":1,"kind":"install","generation":1,"policy":{
        "defaultAccess":"deny", "maxEventsPerSecond":1, "maxQueuedEvents":0,
        "maxSubscriptions":0,"operations":operations
    }})
    .to_string()
}
fn grant(precision: &str, tier: u8) -> Value {
    json!({"access":"allow","maxPrecision":precision,"maxPrivacyTier":tier})
}
fn read(operation: &str, precision: &str, tier: u8) -> String {
    json!({"schemaVersion":1,"kind":"read","generation":1,"operation":operation,
        "maxPrecision":precision,"maxPrivacyTier":tier})
    .to_string()
}
fn response(host: &mut NativeDevice, wire: &str, now: f64) -> Value {
    serde_json::from_str(&host.command(wire, now)).unwrap()
}
fn display(width: u32) -> Sample {
    Sample::Available(
        json!({"hdr":"unknown","heightCssPx":900,"orientation":"landscape",
        "refreshRateHz":60.0,"scale":2.0,"wideColor":"unknown","widthCssPx":width}),
    )
}

#[test]
fn denied_summary_fields_never_query_os_and_have_zero_revision() {
    let (mut host, queries) = host(vec![display(1440)]);
    assert_eq!(
        response(
            &mut host,
            &policy(json!({
                "device.summary.read":grant("exact",1)
            })),
            0.0
        )["ok"],
        true
    );
    let summary = response(&mut host, &read("device.summary.read", "exact", 1), 4.0);
    for field in ["display", "formFactor", "input", "lifecycle", "power"] {
        assert_eq!(summary["value"][field]["status"], "permissionDenied");
        assert_eq!(summary["value"][field]["precision"], "none");
        assert_eq!(summary["value"][field]["revision"], 0);
        assert!(summary["value"][field].get("value").is_none());
    }
    assert_eq!(
        response(&mut host, &read("device.display.read", "exact", 1), 5.0)["code"],
        "capability.denied"
    );
    assert_eq!(queries.load(Ordering::SeqCst), 0);
}

#[test]
fn source_revision_is_shared_by_getter_and_summary_and_ignores_time_and_projection() {
    let (mut host, queries) = host(vec![display(1440), display(1440), display(1470)]);
    assert_eq!(
        response(
            &mut host,
            &policy(json!({
                    "device.summary.read":grant("exact",1),
            "device.display.read":grant("standard",3)
                })),
            0.0
        )["ok"],
        true
    );
    let first = response(&mut host, &read("device.display.read", "coarse", 1), 10.0);
    assert_eq!(first["value"]["revision"], 1);
    assert_eq!(first["value"]["value"]["widthCssPx"], 1400);
    let second = response(&mut host, &read("device.summary.read", "exact", 1), 20.0);
    assert_eq!(second["value"]["display"]["revision"], 1);
    assert_eq!(second["value"]["display"]["precision"], "standard");
    assert_eq!(second["value"]["display"]["value"]["widthCssPx"], 1440);
    assert!(
        second["value"]["display"]["value"]
            .get("refreshRateHz")
            .is_none()
    );
    let third = response(&mut host, &read("device.display.read", "coarse", 1), 30.0);
    assert_eq!(third["value"]["revision"], 2);
    assert_eq!(third["value"]["value"]["widthCssPx"], 1500);
    assert_eq!(queries.load(Ordering::SeqCst), 3);
}

#[test]
fn platform_denial_and_optional_unsupported_keep_reading_discriminants() {
    let (mut host, queries) = host(vec![
        Sample::PermissionDenied,
        Sample::PermissionDenied,
        display(1440),
    ]);
    assert_eq!(
        response(
            &mut host,
            &policy(json!({
                "device.display.read":grant("exact",1),
                "device.power.read":grant("exact",1)
            })),
            0.0
        )["ok"],
        true
    );
    let optional = response(&mut host, &read("device.power.read", "exact", 1), 1.0);
    assert_eq!(optional["value"]["status"], "unsupported");
    assert_eq!(optional["value"]["revision"], 0);
    assert!(optional["value"].get("value").is_none());
    assert_eq!(queries.load(Ordering::SeqCst), 0);
    let first = response(&mut host, &read("device.display.read", "exact", 1), 2.0);
    let repeat = response(&mut host, &read("device.display.read", "exact", 1), 3.0);
    let recovered = response(&mut host, &read("device.display.read", "exact", 1), 4.0);
    assert_eq!(first["value"]["status"], "permissionDenied");
    assert_eq!(first["value"]["precision"], "none");
    assert_eq!(first["value"]["revision"], 1);
    assert_eq!(repeat["value"]["revision"], 1);
    assert_eq!(recovered["value"]["status"], "available");
    assert_eq!(recovered["value"]["revision"], 2);
}

#[test]
fn coarse_display_scale_preserves_eight_and_sixteen_bounds() {
    for scale in [8.0, 16.0] {
        let value = json!({
            "hdr":"unknown", "heightCssPx":900, "orientation":"landscape",
            "refreshRateHz":60.0, "scale":scale, "wideColor":"unknown", "widthCssPx":1440
        });
        let projected = project("device.display.read", value, Precision::Coarse);
        assert_eq!(projected["scale"], scale);
    }
}

#[test]
fn source_revision_overflow_fails_without_replacing_cached_sample() {
    let (mut host, queries) = host(vec![display(1440), display(1470)]);
    assert_eq!(
        response(
            &mut host,
            &policy(json!({
                "device.display.read":grant("exact",1)
            })),
            0.0
        )["ok"],
        true
    );
    let first = response(&mut host, &read("device.display.read", "exact", 1), 1.0);
    assert_eq!(first["value"]["revision"], 1);
    let cached = host.cache.get_mut("device.display.read").unwrap();
    cached.revision = MAX_SAFE_REVISION;
    let failed = response(&mut host, &read("device.display.read", "exact", 1), 2.0);
    assert_eq!(failed["code"], "provider.quota");
    let cached = host.cache.get("device.display.read").unwrap();
    assert_eq!(cached.revision, MAX_SAFE_REVISION);
    assert_eq!(cached.source, display(1440));
    assert_eq!(queries.load(Ordering::SeqCst), 2);
}

#[test]
fn strict_generation_installation_and_close_reject_later_queries() {
    let (mut absent, absent_queries) = host(vec![display(1440)]);
    absent.selected = false;
    assert_eq!(
        response(&mut absent, &policy(json!({})), 0.0)["code"],
        "provider.unavailable"
    );
    assert_eq!(absent_queries.load(Ordering::SeqCst), 0);
    let (mut host, queries) = host(vec![display(1440)]);
    let mut malformed: Value = serde_json::from_str(&policy(json!({}))).unwrap();
    malformed["extra"] = json!(true);
    assert_eq!(
        response(&mut host, &malformed.to_string(), 0.0)["code"],
        "provider.protocol_error"
    );
    assert_eq!(
        response(
            &mut host,
            &policy(json!({
                "device.display.read":grant("exact",1)
            })),
            0.0
        )["ok"],
        true
    );
    let mut stale: Value = serde_json::from_str(&read("device.display.read", "exact", 1)).unwrap();
    stale["generation"] = json!(2);
    assert_eq!(
        response(&mut host, &stale.to_string(), 1.0)["code"],
        "provider.protocol_error"
    );
    assert_eq!(queries.load(Ordering::SeqCst), 0);
    assert_eq!(
        response(
            &mut host,
            &json!({"schemaVersion":1,"kind":"close","generation":1}).to_string(),
            2.0
        )["ok"],
        true
    );
    assert_eq!(
        response(&mut host, &read("device.display.read", "exact", 1), 3.0)["code"],
        "provider.unavailable"
    );
    assert_eq!(queries.load(Ordering::SeqCst), 0);
}

#[cfg(target_os = "macos")]
#[test]
fn real_mac_probes_use_reading_envelopes_without_raw_identity() {
    let mut host = NativeDevice::new(true);
    let operations = json!({
        "device.form-factor.read":grant("exact",0),
        "device.display.read":grant("exact",1),
        "device.input.read":grant("exact",1),
        "device.lifecycle.read":grant("exact",1)
    });
    assert_eq!(response(&mut host, &policy(operations), 0.0)["ok"], true);
    for (operation, tier) in [
        ("device.form-factor.read", 0),
        ("device.display.read", 1),
        ("device.input.read", 1),
        ("device.lifecycle.read", 1),
    ] {
        let value = response(&mut host, &read(operation, "exact", tier), 1.0);
        println!("mac_device_probe {operation} {value}");
        assert_eq!(value["ok"], true, "{value}");
        assert_ne!(value["value"]["status"], "unsupported", "{operation}");
        assert!(value["value"]["revision"].as_u64().is_some());
        let text = value.to_string();
        assert!(!text.contains("MacBook") && !text.contains("Macmini"));
    }
}
