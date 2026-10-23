//! Host-private, read-only Device source. The JS Kernel owns the public facade,
//! Broker and subscription resources; this module only samples an admitted OS
//! operation and maintains its operation-local source revision.
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[cfg(target_os = "macos")]
mod darwin;

const MAX_COMMAND_BYTES: usize = 16 * 1024;
const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq)]
enum Sample {
    Available(Value),
    Unavailable,
    PermissionDenied,
}

trait DeviceSource {
    fn read(&mut self, operation: &str) -> Sample;
}

#[cfg(not(target_os = "macos"))]
struct UnavailableSource;
#[cfg(not(target_os = "macos"))]
impl DeviceSource for UnavailableSource {
    fn read(&mut self, _operation: &str) -> Sample {
        Sample::Unavailable
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DevicePolicy {
    default_access: String,
    max_events_per_second: u32,
    max_queued_events: u32,
    max_subscriptions: u32,
    operations: BTreeMap<String, Grant>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Grant {
    access: String,
    max_precision: Precision,
    max_privacy_tier: u8,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
enum Precision {
    Coarse,
    Standard,
    Exact,
}

impl Precision {
    fn name(self) -> &'static str {
        match self {
            Self::Coarse => "coarse",
            Self::Standard => "standard",
            Self::Exact => "exact",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Command {
    #[serde(rename = "install")]
    Install {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        generation: u64,
        policy: DevicePolicy,
    },
    #[serde(rename = "read")]
    Read {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        generation: u64,
        operation: String,
        #[serde(rename = "maxPrecision")]
        max_precision: Precision,
        #[serde(rename = "maxPrivacyTier")]
        max_privacy_tier: u8,
    },
    #[serde(rename = "close")]
    Close {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        generation: u64,
    },
}

impl DevicePolicy {
    fn valid(&self) -> bool {
        self.default_access == "deny"
            && (1..=1000).contains(&self.max_events_per_second)
            && self.max_queued_events <= 4096
            && self.max_subscriptions <= 256
            && self.operations.iter().all(|(op, grant)| {
                operation_tier(op).is_some_and(|tier| {
                    grant.access == "allow" && (tier..=3).contains(&grant.max_privacy_tier)
                })
            })
    }

    fn allows(&self, operation: &str, precision: Precision, tier: u8) -> bool {
        self.operations.get(operation).is_some_and(|grant| {
            tier >= operation_tier(operation).unwrap_or(4)
                && tier <= grant.max_privacy_tier
                && precision <= grant.max_precision
        })
    }
}

fn operation_tier(operation: &str) -> Option<u8> {
    Some(match operation {
        "device.form-factor.read" | "device.events.subscribe" => 0,
        "device.display.read"
        | "device.input.read"
        | "device.lifecycle.read"
        | "device.power.read"
        | "device.summary.read" => 1,
        "device.connectivity.read"
        | "device.connectivity.cellular.state.read"
        | "device.connectivity.wifi.state.read"
        | "device.media.capabilities.read"
        | "device.security.capabilities.read"
        | "device.sensor.capabilities.read"
        | "device.thermal.read" => 2,
        "device.connectivity.wifi.identity.read" => 3,
        _ => return None,
    })
}

fn required_source(operation: &str) -> bool {
    matches!(
        operation,
        "device.form-factor.read"
            | "device.display.read"
            | "device.input.read"
            | "device.lifecycle.read"
    )
}

struct CacheEntry {
    source: Sample,
    revision: u64,
}

/// One owner per installed Host generation. No OS work occurs at construction or install.
pub struct NativeDevice {
    selected: bool,
    closed: bool,
    policy: Option<DevicePolicy>,
    source: Box<dyn DeviceSource>,
    cache: BTreeMap<&'static str, CacheEntry>,
}

impl NativeDevice {
    pub fn new(selected: bool) -> Self {
        #[cfg(target_os = "macos")]
        let source: Box<dyn DeviceSource> = Box::new(darwin::DarwinSource);
        #[cfg(not(target_os = "macos"))]
        let source: Box<dyn DeviceSource> = Box::new(UnavailableSource);
        Self {
            selected: selected && cfg!(all(target_os = "macos", target_arch = "aarch64")),
            closed: false,
            policy: None,
            source,
            cache: BTreeMap::new(),
        }
    }

    pub fn command(&mut self, encoded: &str, observed_at: f64) -> String {
        if encoded.len() > MAX_COMMAND_BYTES
            || !observed_at.is_finite()
            || !(0.0..=MAX_SAFE_REVISION as f64).contains(&observed_at)
        {
            return failure("provider.protocol_error");
        }
        let Ok(command) = serde_json::from_str::<Command>(encoded) else {
            return failure("provider.protocol_error");
        };
        let (schema_version, generation) = match &command {
            Command::Install {
                schema_version,
                generation,
                ..
            }
            | Command::Read {
                schema_version,
                generation,
                ..
            }
            | Command::Close {
                schema_version,
                generation,
            } => (*schema_version, *generation),
        };
        if schema_version != 1 || generation != 1 {
            return failure("provider.protocol_error");
        }
        match command {
            Command::Install { policy, .. } => {
                if self.closed || self.policy.is_some() {
                    return failure("provider.protocol_error");
                }
                if !self.selected {
                    return failure("provider.unavailable");
                }
                if !policy.valid() {
                    return failure("provider.protocol_error");
                }
                self.policy = Some(policy);
                success(json!({"generation":1}))
            }
            Command::Read {
                operation,
                max_precision,
                max_privacy_tier,
                ..
            } => {
                if self.closed || self.policy.is_none() {
                    return failure("provider.unavailable");
                }
                if operation == "device.events.subscribe"
                    || operation_tier(&operation).is_none()
                    || max_privacy_tier > 3
                {
                    return failure("provider.protocol_error");
                }
                let policy = self.policy.as_ref().unwrap();
                if !policy.allows(&operation, max_precision, max_privacy_tier) {
                    return failure("capability.denied");
                }
                let value = if operation == "device.summary.read" {
                    self.summary(max_precision, max_privacy_tier, observed_at)
                } else {
                    self.reading(&operation, max_precision, observed_at)
                };
                match value {
                    Ok(value) => success(value),
                    Err(code) => failure(code),
                }
            }
            Command::Close { .. } => {
                self.closed = true;
                self.policy = None;
                self.cache.clear();
                success(json!({"closed":true}))
            }
        }
    }

    fn summary(
        &mut self,
        outer_precision: Precision,
        outer_tier: u8,
        now: f64,
    ) -> Result<Value, &'static str> {
        let fields = [
            ("display", "device.display.read"),
            ("formFactor", "device.form-factor.read"),
            ("input", "device.input.read"),
            ("lifecycle", "device.lifecycle.read"),
            ("power", "device.power.read"),
        ];
        let mut output = serde_json::Map::new();
        output.insert("schemaVersion".into(), json!(1));
        for (field, operation) in fields {
            let field_grant = self.policy.as_ref().unwrap().operations.get(operation);
            let reading = if let Some(grant) = field_grant {
                if outer_tier < operation_tier(operation).unwrap()
                    || grant.max_privacy_tier < operation_tier(operation).unwrap()
                {
                    no_value("permissionDenied", now, 0)
                } else {
                    self.reading(operation, outer_precision.min(grant.max_precision), now)?
                }
            } else {
                no_value("permissionDenied", now, 0)
            };
            output.insert(field.into(), reading);
        }
        Ok(Value::Object(output))
    }

    fn reading(
        &mut self,
        operation: &str,
        precision: Precision,
        now: f64,
    ) -> Result<Value, &'static str> {
        if !required_source(operation) {
            return Ok(no_value("unsupported", now, 0));
        }
        // The only caller first checked the operation's compiled grant. Summary
        // checks each field grant separately before reaching this function.
        let raw = self.source.read(operation);
        let key = match operation {
            "device.form-factor.read" => "device.form-factor.read",
            "device.display.read" => "device.display.read",
            "device.input.read" => "device.input.read",
            "device.lifecycle.read" => "device.lifecycle.read",
            _ => unreachable!(),
        };
        let entry = self.cache.entry(key).or_insert_with(|| CacheEntry {
            source: raw.clone(),
            revision: 1,
        });
        if entry.source != raw {
            if entry.revision >= MAX_SAFE_REVISION {
                return Err("provider.quota");
            }
            entry.source = raw.clone();
            entry.revision += 1;
        }
        Ok(match raw {
            Sample::Available(value) => json!({
                "status":"available", "observedAt":now, "precision":precision.name(),
                "revision":entry.revision, "value":project(operation, value, precision)
            }),
            Sample::Unavailable => no_value("unavailable", now, entry.revision),
            Sample::PermissionDenied => no_value("permissionDenied", now, entry.revision),
        })
    }
}

fn project(operation: &str, mut value: Value, precision: Precision) -> Value {
    if operation == "device.display.read" {
        if precision != Precision::Exact {
            value.as_object_mut().unwrap().remove("refreshRateHz");
        }
        if precision == Precision::Coarse {
            for field in ["widthCssPx", "heightCssPx"] {
                if let Some(number) = value[field].as_u64() {
                    value[field] = json!(((number + 50) / 100 * 100).max(1));
                }
            }
            if let Some(scale) = value["scale"].as_f64() {
                value["scale"] = json!(((scale * 2.0).round() / 2.0).clamp(0.25, 16.0));
            }
        }
    }
    value
}

fn no_value(status: &str, now: f64, revision: u64) -> Value {
    json!({"status":status,"observedAt":now,"precision":"none","revision":revision})
}
fn success(value: Value) -> String {
    json!({"schemaVersion":1,"ok":true,"value":value}).to_string()
}
fn failure(code: &str) -> String {
    json!({"schemaVersion":1,"ok":false,"code":code}).to_string()
}

#[cfg(test)]
mod tests;
