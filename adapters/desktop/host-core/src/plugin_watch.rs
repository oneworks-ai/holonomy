//! Observe only the Host configuration; plugin execution and graph diffing stay in Cordis.
use crate::HostConfiguration;
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant, SystemTime},
};

#[derive(PartialEq, Eq)]
struct Stamp {
    modified: Option<SystemTime>,
    length: u64,
    device: u64,
    inode: u64,
    changed: i64,
    changed_nanos: i64,
}

fn stamp(path: &std::path::Path) -> Option<Stamp> {
    use std::os::unix::fs::MetadataExt;
    let value = fs::symlink_metadata(path).ok()?;
    Some(Stamp {
        modified: value.modified().ok(),
        length: value.len(),
        device: value.dev(),
        inode: value.ino(),
        changed: value.ctime(),
        changed_nanos: value.ctime_nsec(),
    })
}

fn fixed_configuration(configuration: &HostConfiguration) -> Value {
    let mut value = serde_json::to_value(configuration).expect("Serializable Host config");
    let value_object = value.as_object_mut().expect("Host config is an object");
    for key in [
        "plugins",
        "runtimePlugins",
        "runtimePluginRoots",
        "pluginGraphRevision",
        "privateSources",
    ] {
        value_object.remove(key);
    }
    value
}

pub struct PluginConfigWatch {
    admission: crate::SourceAdmission,
    path: PathBuf,
    fixed: Value,
    process_profile: Option<Value>,
    active_plugins: Value,
    observed: Option<Option<Stamp>>,
    next_check: Instant,
}

impl PluginConfigWatch {
    pub fn new(path: PathBuf, initial: &HostConfiguration) -> Self {
        Self {
            admission: initial.plugin_sources.admission.clone(),
            path,
            fixed: fixed_configuration(initial),
            process_profile: initial.process_profile.clone(),
            active_plugins: Self::plugins(initial),
            observed: None,
            next_check: Instant::now(),
        }
    }

    pub fn plugins(configuration: &HostConfiguration) -> Value {
        serde_json::to_value(&configuration.plugins).expect("Serializable plugin configuration")
    }

    pub fn poll(&mut self, now: Instant) -> Result<Option<HostConfiguration>, &'static str> {
        if now < self.next_check {
            return Ok(None);
        }
        self.next_check = now + Duration::from_millis(250);
        let observed = stamp(&self.path);
        if self.observed.as_ref() == Some(&observed) {
            return Ok(None);
        }
        self.observed = Some(observed);
        let mut candidate =
            HostConfiguration::read_with_admission(&self.path, self.admission.clone())
                .map_err(|_| "invalid configuration or source conflict")?;
        // The selected owner-private profile was admitted once before entry.
        // Plugin reloads carry only its logical ID; never reread its manifest.
        candidate.process_profile = self.process_profile.clone();
        if fixed_configuration(&candidate) != self.fixed {
            return Err("non-plugin configuration changed; restart required");
        }
        if Self::plugins(&candidate) == self.active_plugins {
            return Ok(None);
        }
        Ok(Some(candidate))
    }

    pub fn commit(&mut self, plugins: Value) {
        self.active_plugins = plugins;
    }
}
