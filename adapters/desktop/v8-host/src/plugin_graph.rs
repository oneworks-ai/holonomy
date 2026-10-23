//! Immutable plugin graph admission, independent from the mutable config watcher.
use crate::state::{HostState, state};
use holonomy_desktop_host::{MAX_GRAPH_BYTES, MAX_MODULE_BYTES, MAX_MODULES};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub const BOOTSTRAP_OWNER: &str = "holo-host-bootstrap";

pub struct PluginGraph {
    members: Vec<String>,
    fingerprint: String,
    bytes: usize,
    pending: usize,
    released: bool,
}

pub(crate) struct PreparedGraph {
    pub(crate) entry: String,
    fingerprint: String,
    bytes: usize,
    pub(crate) definitions: HashMap<String, Value>,
    pub(crate) dependencies: HashMap<String, HashMap<String, String>>,
}

fn canonical(url: &str, root: &str) -> bool {
    let Ok(value) = url::Url::parse(url) else {
        return false;
    };
    url.starts_with(root)
        && url != root
        && value.as_str() == url
        && value.scheme() == "holo-plugins"
        && value.host_str().is_none()
        && value.query().is_none()
        && value.fragment().is_none()
}

fn prepare(source: &str, digest: &str) -> Result<PreparedGraph, String> {
    if source.len() > MAX_GRAPH_BYTES * 8
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("Invalid plugin graph digest or size".into());
    }
    let plan: Value = serde_json::from_str(source).map_err(|_| "Invalid plugin graph")?;
    let root = plan["rootUrl"].as_str().ok_or("Missing plugin root")?;
    if !root.starts_with("holo-plugins:///") || !root.ends_with('/') {
        return Err("Invalid plugin root".into());
    }
    let modules = plan["modules"].as_array().ok_or("Missing plugin modules")?;
    if modules.is_empty() || modules.len() > MAX_MODULES {
        return Err("Plugin graph module limit".into());
    }
    let versioned = |url: &str| format!("{url}?holo-bundle={digest}");
    let entry = plan["entryUrl"].as_str().ok_or("Missing plugin entry")?;
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&plan).map_err(|_| "Invalid plugin graph")?)
    );
    let mut definitions = HashMap::new();
    let mut bytes = 0;
    for module in modules {
        let url = module["url"].as_str().ok_or("Invalid plugin identity")?;
        let text = module["source"].as_str().ok_or("Missing plugin source")?;
        if !canonical(url, root)
            || module["format"] != "module"
            || text.len() as u64 > MAX_MODULE_BYTES
            || module["sha256"].as_str()
                != Some(format!("{:x}", Sha256::digest(text.as_bytes())).as_str())
        {
            return Err("Invalid plugin source identity or integrity".into());
        }
        bytes += text.len();
        if bytes > MAX_GRAPH_BYTES {
            return Err("Plugin graph byte limit".into());
        }
        let mut definition = module.clone();
        definition["url"] = Value::String(versioned(url));
        if definitions.insert(versioned(url), definition).is_some() {
            return Err("Duplicate plugin module".into());
        }
    }
    if bytes > MAX_GRAPH_BYTES || !definitions.contains_key(&versioned(entry)) {
        return Err("Invalid plugin entry or graph size".into());
    }
    let mut dependencies = HashMap::new();
    for module in modules {
        let parent = versioned(module["url"].as_str().unwrap());
        let mut edges = HashMap::new();
        let raw = module["dependencies"]
            .as_array()
            .ok_or("Invalid plugin dependencies")?;
        if raw.len() > 4096 {
            return Err("Plugin dependency limit".into());
        }
        for dependency in raw {
            match (
                dependency["specifier"].as_str(),
                dependency["resolvedUrl"].as_str(),
            ) {
                (Some(specifier), Some(target))
                    if matches!(
                        dependency["kind"].as_str(),
                        Some("import" | "dynamic-import")
                    ) =>
                {
                    let target = versioned(target);
                    if specifier.len() > 4096 || !definitions.contains_key(&target) {
                        return Err("Plugin dependency escapes graph".into());
                    }
                    if let Some(previous) = edges.insert(specifier.into(), target.clone())
                        && previous != target
                    {
                        return Err("Conflicting plugin dependency".into());
                    }
                }
                (None, None) if dependency["kind"] == "dynamic-import" => {}
                _ => return Err("Unsupported plugin dependency".into()),
            }
        }
        let mut versioned_dependencies = raw.clone();
        for dependency in &mut versioned_dependencies {
            if let Some(target) = dependency["resolvedUrl"].as_str() {
                dependency["resolvedUrl"] = Value::String(versioned(target));
            }
        }
        definitions.get_mut(&parent).unwrap()["dependencies"] =
            Value::Array(versioned_dependencies);
        dependencies.insert(parent, edges);
    }
    Ok(PreparedGraph {
        entry: versioned(entry),
        fingerprint,
        bytes,
        definitions,
        dependencies,
    })
}

/// A diagnostic helper consumes the same exact, integrity-checked plan edges
/// as ordinary plugin graph admission, without mutating the Host graph cache.
pub(crate) fn prepare_observer_plan(source: &str, digest: &str) -> Result<PreparedGraph, String> {
    // Four MiB of source can expand through JSON escaping. Refuse an
    // implausibly large plan before the existing general graph parser allocates.
    if source.len() > 32 * 1024 * 1024 {
        return Err("Observer module plan limit".into());
    }
    let graph = prepare(source, digest)?;
    if graph.definitions.len() > 128
        || graph.bytes > 4 * 1024 * 1024
        || graph.definitions.values().any(|definition| {
            definition["source"]
                .as_str()
                .is_none_or(|source| source.len() > 1024 * 1024)
        })
    {
        return Err("Observer module plan limit".into());
    }
    Ok(graph)
}

pub fn install(scope: &mut v8::PinScope, source: &str, digest: &str) -> Result<String, String> {
    let graph = prepare(source, digest)?;
    let shared = state(scope);
    let mut state = shared.borrow_mut();
    if let Some(existing) = state.plugin_graphs.get_mut(&graph.entry) {
        if existing.fingerprint != graph.fingerprint {
            return Err("Plugin graph changed under the same digest".into());
        }
        existing.released = false;
        return Ok(graph.entry);
    }
    if state.plugin_graphs.len() >= 256
        || state.definitions.len() + graph.definitions.len() > MAX_MODULES
        || state.plugin_graphs.values().map(|g| g.bytes).sum::<usize>() + graph.bytes
            > MAX_GRAPH_BYTES
    {
        return Err("Native plugin graph capacity exceeded".into());
    }
    let members: Vec<String> = graph.definitions.keys().cloned().collect();
    if members
        .iter()
        .any(|url| state.definitions.contains_key(url))
    {
        return Err("Plugin graph identity collision".into());
    }
    for url in &members {
        state
            .plugin_members
            .insert(url.clone(), graph.entry.clone());
    }
    state.definitions.extend(graph.definitions);
    state.dependencies.extend(graph.dependencies);
    state.plugin_graphs.insert(
        graph.entry.clone(),
        PluginGraph {
            members,
            fingerprint: graph.fingerprint,
            bytes: graph.bytes,
            pending: 0,
            released: false,
        },
    );
    Ok(graph.entry)
}

pub fn import_target(
    state: &mut HostState,
    parent: &str,
    requested: &str,
) -> Option<(String, String)> {
    let target = if parent == BOOTSTRAP_OWNER {
        state
            .plugin_graphs
            .contains_key(requested)
            .then(|| requested.to_owned())?
    } else {
        let graph = state.plugin_members.get(parent)?;
        if state.plugin_graphs.get(graph)?.released {
            return None;
        }
        state.dependencies.get(parent)?.get(requested)?.clone()
    };
    let graph_id = state.plugin_members.get(&target)?.clone();
    let graph = state.plugin_graphs.get_mut(&graph_id)?;
    if graph.released {
        return None;
    }
    graph.pending = graph.pending.checked_add(1)?;
    Some((target, graph_id))
}

pub fn release(state: &mut HostState, entry: &str) {
    if let Some(graph) = state.plugin_graphs.get_mut(entry) {
        graph.released = true;
    }
    collect(state, entry);
}

pub fn finish_import(state: &mut HostState, entry: &str) {
    if let Some(graph) = state.plugin_graphs.get_mut(entry) {
        graph.pending = graph.pending.saturating_sub(1);
    }
    collect(state, entry);
}

fn collect(state: &mut HostState, entry: &str) {
    if !state
        .plugin_graphs
        .get(entry)
        .is_some_and(|g| g.released && g.pending == 0)
    {
        return;
    }
    let graph = state.plugin_graphs.remove(entry).unwrap();
    for url in graph.members {
        state.plugin_members.remove(&url);
        state.definitions.remove(&url);
        state.dependencies.remove(&url);
        state.modules.remove(&url);
        state.commonjs.remove(&url);
        state.import_owners.remove(&url);
    }
}

pub fn import_options<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    owner: &str,
) -> v8::Local<'s, v8::Data> {
    let options = v8::PrimitiveArray::new(scope, 1);
    let marker = v8::String::new(scope, owner).expect("Bounded module identity");
    options.set(scope, 0, marker.into());
    let data: v8::Local<v8::Data> = options.into();
    state(scope)
        .borrow_mut()
        .import_owners
        .insert(owner.into(), v8::Global::new(scope, options));
    data
}

pub fn import_owner(scope: &v8::PinScope, options: v8::Local<v8::Data>) -> Option<String> {
    state(scope)
        .borrow()
        .import_owners
        .iter()
        .find_map(|(owner, handle)| {
            (v8::Local::new(scope, handle) == options).then(|| owner.clone())
        })
}

#[cfg(test)]
#[path = "plugin_graph_tests.rs"]
mod tests;
