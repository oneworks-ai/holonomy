use crate::FilesystemRootInstallation;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::{CStr, CString},
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    sync::atomic::{AtomicU64, Ordering},
};

mod metadata;
mod paths;
mod positioned;
mod rename;
mod resolution;
mod resources;
mod watch;
use paths::{
    child_name, decode_canonical_segment, encode_canonical_segment, open_relative, parent,
    reject_symlink,
};
use resolution::{PinnedTarget, ResolutionIntent, ResolvedExecution};
static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

pub struct NativeFilesystem {
    watchers: watch::Watchers,
    renames: rename::Renames,
    resolutions: resolution::Resolutions,
    resources: resources::Resources,
    roots: HashMap<String, File>,
    root_paths: HashMap<String, Vec<std::path::PathBuf>>,
    installations: Vec<FilesystemRootInstallation>,
    policy: Option<Value>,
}
type Result<T> = std::result::Result<T, &'static str>;
fn io_error(error: std::io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(libc::ENOENT) => "resource.not_found",
        Some(libc::EEXIST) => "resource.exists",
        Some(libc::EACCES | libc::EPERM) => "provider.permission_denied",
        Some(libc::ELOOP) => "resource.cross_root",
        Some(libc::EMFILE | libc::ENFILE) => "resource.handle_limit",
        Some(libc::EXDEV) => "resource.cross_root",
        Some(libc::ENOSPC) => "provider.quota",
        _ => "provider.unavailable",
    }
}
impl NativeFilesystem {
    pub fn new(installations: Vec<FilesystemRootInstallation>) -> Self {
        Self {
            watchers: watch::Watchers::default(),
            renames: rename::Renames::default(),
            resolutions: resolution::Resolutions::default(),
            resources: resources::Resources::default(),
            roots: HashMap::new(),
            root_paths: HashMap::new(),
            installations,
            policy: None,
        }
    }
    pub fn dispatch(&mut self, input: &str) -> String {
        let outcome = (|| {
            if input.len() > 1024 * 1024 {
                return Err("argument.invalid");
            }
            let input: Value = serde_json::from_str(input).map_err(|_| "argument.invalid")?;
            match input["kind"].as_str() {
                Some("poll") => self.watchers.poll(),
                Some("closeWatch") => {
                    self.watchers
                        .close(input["bindingId"].as_str().ok_or("argument.invalid")?);
                    Ok(json!({}))
                }
                Some("verifyRename") => self
                    .renames
                    .verify(input["ticket"].as_str().ok_or("argument.invalid")?),
                Some("closeRename") => {
                    self.renames
                        .close(input["ticket"].as_str().ok_or("argument.invalid")?);
                    Ok(json!({}))
                }
                Some("prepareResolution") => self.prepare_resolution(&input),
                Some("verifyResolution") => {
                    let ticket = input["ticket"].as_str().ok_or("argument.invalid")?;
                    let root_id = input["rootId"].as_str().ok_or("argument.invalid")?;
                    let root = self.roots.get(root_id).ok_or("provider.unavailable")?;
                    self.resolutions.verify(root, ticket)
                }
                Some("closeResolution") => {
                    self.resolutions
                        .close(input["ticket"].as_str().ok_or("argument.invalid")?);
                    Ok(json!({}))
                }
                Some("close") => {
                    self.resources
                        .close(input["bindingId"].as_str().ok_or("argument.invalid")?);
                    Ok(json!({}))
                }
                Some("install") => self.install(input["filesystem"].clone()),
                Some("invoke") => self.invoke(&input),
                _ => Err("argument.invalid"),
            }
        })();
        match outcome {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(code) => json!({"ok":false,"code":code}),
        }
        .to_string()
    }
    fn install(&mut self, policy: Value) -> Result<Value> {
        if self.policy.is_some() {
            return Err("provider.protocol_error");
        }
        if policy["access"] == "sandboxed" {
            for root in policy["roots"].as_array().ok_or("argument.invalid")? {
                if root["symlinks"] != "deny" && root["symlinks"] != "withinRoot" {
                    return Err("argument.invalid");
                }
                let id = root["rootId"].as_str().ok_or("argument.invalid")?;
                let installation = self
                    .installations
                    .iter()
                    .find(|i| i.root_id == id)
                    .ok_or("provider.unavailable")?;
                use std::os::unix::fs::OpenOptionsExt;
                let directory = OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                    .open(&installation.host_path)
                    .map_err(io_error)?;
                let mut paths = vec![installation.host_path.clone()];
                if let Ok(canonical) = installation.host_path.canonicalize()
                    && !paths.contains(&canonical)
                {
                    paths.push(canonical);
                }
                self.root_paths.insert(id.into(), paths);
                self.roots.insert(id.into(), directory);
            }
        } else if policy["access"] != "none" {
            return Err("argument.invalid");
        }
        self.policy = Some(policy);
        Ok(json!({}))
    }
    fn prepare_resolution(&mut self, input: &Value) -> Result<Value> {
        let policy = self.policy.as_ref().ok_or("provider.protocol_error")?;
        let operation = input["operation"].as_str().ok_or("argument.invalid")?;
        metadata::parse(
            operation,
            &input["arguments"],
            false,
            input["linuxProcess"] == true,
        )?;
        metadata::validate_directory_resource(
            operation,
            &input["arguments"],
            false,
            input["linuxProcess"] == true,
        )?;
        let root_id = input["rootId"].as_str().ok_or("argument.invalid")?;
        let requested = segments(&input["pathSegments"])?;
        let root_policy = policy["roots"]
            .as_array()
            .and_then(|roots| roots.iter().find(|root| root["rootId"] == root_id))
            .ok_or("capability.denied")?;
        if root_policy["symlinks"] == "deny" {
            return Ok(json!({"required":false}));
        }
        if root_policy["symlinks"] != "withinRoot" {
            return Err("capability.denied");
        }
        let required = required_rights(operation, &input["arguments"])?;
        authorize(
            root_id,
            &requested,
            &required,
            root_policy,
            &input["constraints"],
            false,
        )?;
        let behavior = resolution_behavior(operation, &input["arguments"])?;
        let intent = ResolutionIntent {
            operation: operation.into(),
            flag: match operation {
                "filesystem.file.open" => Some(input["arguments"]["flag"].clone()),
                "filesystem.file.write" => Some(json!(
                    input["arguments"]["options"]["flag"]
                        .as_str()
                        .unwrap_or("w")
                )),
                "filesystem.metadata.access" => Some(input["arguments"]["mode"].clone()),
                _ => None,
            },
            recursive: input["arguments"]["options"]["recursive"] == true,
        };
        let root = self.roots.get(root_id).ok_or("provider.unavailable")?;
        let root_paths = self.root_paths.get(root_id).ok_or("provider.unavailable")?;
        let mut value = self
            .resolutions
            .prepare(root, root_paths, root_id, intent, &requested, behavior)?;
        value["required"] = json!(true);
        Ok(value)
    }
    fn invoke(&mut self, input: &Value) -> Result<Value> {
        let policy = self
            .policy
            .as_ref()
            .ok_or("provider.protocol_error")?
            .clone();
        let operation = input["operation"].as_str().ok_or("argument.invalid")?;
        if operation != "filesystem.metadata.chmod"
            && input["arguments"].get("expectedKind").is_some()
        {
            return Err("argument.invalid");
        }
        let action = metadata::parse(
            operation,
            &input["arguments"],
            input["bindingId"].is_string(),
            input["linuxProcess"] == true,
        )?;
        metadata::validate_directory_resource(
            operation,
            &input["arguments"],
            input["bindingId"].is_string(),
            input["linuxProcess"] == true,
        )?;
        let required = required_rights(operation, &input["arguments"])?;
        let root_id = input["rootId"].as_str().ok_or("argument.invalid")?;
        let parts = segments(&input["pathSegments"])?;
        let root_policy = policy["roots"]
            .as_array()
            .and_then(|roots| roots.iter().find(|root| root["rootId"] == root_id))
            .ok_or("capability.denied")?;
        let constraints = &input["constraints"];
        let selected = authorize(
            root_id,
            &parts,
            &required,
            root_policy,
            constraints,
            input["bindingId"].is_string(),
        )?;
        if !root_policy["rights"].as_array().is_some_and(|rights| {
            required
                .iter()
                .all(|right| rights.iter().any(|r| r == right))
        }) || input["bindingId"].is_null()
            && !parts.starts_with(&segments(&selected["pathPrefixSegments"])?)
        {
            return Err("capability.denied");
        }
        let root = self.roots.get(root_id).ok_or("provider.unavailable")?;
        let args = &input["arguments"];
        let resolved_execution = if root_policy["symlinks"] == "withinRoot"
            && input["bindingId"].is_null()
            && operation != "filesystem.entry.rename"
            && !matches!(
                operation,
                "filesystem.file.close" | "filesystem.directory.close" | "filesystem.watch.close"
            ) {
            let requested = segments(&input["requestedSegments"])?;
            let ticket = input["resolutionTicket"]
                .as_str()
                .ok_or("provider.protocol_error")?;
            Some(
                self.resolutions
                    .consume(ticket, operation, root_id, &requested, &parts)?,
            )
        } else {
            None
        };
        let limit = |key: &str| -> Result<usize> {
            let n = policy["limits"][key]
                .as_u64()
                .ok_or("capability.denied")?
                .min(
                    constraints["limits"][key]
                        .as_u64()
                        .ok_or("capability.denied")?,
                );
            usize::try_from(n).map_err(|_| "capability.denied")
        };
        match operation {
            "filesystem.watch.subscribe" => {
                if args["options"]["recursive"] == true {
                    return Err("argument.invalid");
                }
                let maximum = limit("maxWatchers")?;
                let queue_maximum = limit("maxQueuedEvents")?;
                let requested = args["options"]["maxQueuedEvents"]
                    .as_u64()
                    .map(|n| n as usize)
                    .unwrap_or(queue_maximum);
                if requested == 0 || requested > queue_maximum {
                    return Err("resource.event_limit");
                }
                let file = match resolved_execution {
                    Some(ResolvedExecution {
                        target: PinnedTarget::Existing(file),
                        ..
                    }) => file,
                    Some(_) => return Err("provider.protocol_error"),
                    None => open_relative(root, &parts, libc::O_RDONLY, 0).map_err(io_error)?,
                };
                let metadata = file.metadata().map_err(io_error)?;
                if !(metadata.is_file() || metadata.is_dir()) {
                    return Err("provider.unavailable");
                }
                let mut value = self.watchers.open(
                    file,
                    args["options"]["persistent"] != false,
                    maximum,
                    limit("maxDirectoryEntries")?,
                    parts.last().cloned(),
                )?;
                value["maxQueuedEvents"] = json!(requested);
                Ok(value)
            }
            "filesystem.watch.close" => {
                self.watchers
                    .close(input["bindingId"].as_str().ok_or("resource.stale")?);
                Ok(json!({}))
            }
            "filesystem.file.open" => {
                let flag = resources::OpenFlag::parse(&args["flag"])?;
                if let Some(execution) = resolved_execution {
                    self.resources.open_resolved(
                        execution.target,
                        root_id,
                        &flag,
                        limit("maxOpenHandles")?.min(4096),
                    )
                } else {
                    self.resources.open(
                        root,
                        root_id,
                        &parts,
                        &flag,
                        limit("maxOpenHandles")?.min(4096),
                    )
                }
            }
            "filesystem.directory.open" => {
                let directory = match resolved_execution {
                    Some(ResolvedExecution {
                        target: PinnedTarget::Existing(directory),
                        ..
                    }) => directory,
                    Some(_) => return Err("provider.protocol_error"),
                    None => open_relative(root, &parts, libc::O_RDONLY | libc::O_DIRECTORY, 0)
                        .map_err(io_error)?,
                };
                self.resources.open_directory(
                    directory,
                    root_id,
                    limit("maxOpenHandles")?.min(4096),
                    limit("maxDirectoryEntries")?.min(65536),
                )
            }
            "filesystem.directory.close" => {
                let id = input["bindingId"].as_str().ok_or("resource.stale")?;
                self.resources.close_directory(id, root_id)?;
                Ok(json!({}))
            }
            "filesystem.file.close" => {
                let id = input["bindingId"].as_str().ok_or("resource.stale")?;
                self.resources.file(id, root_id, &parts, "")?;
                self.resources.close(id);
                Ok(json!({}))
            }
            "filesystem.file.read" => {
                let maximum = limit("maxReadBytes")?.min(8 * 1024 * 1024);
                let file = if let Some(id) = input["bindingId"].as_str() {
                    self.resources.file(id, root_id, &parts, "read")?
                } else {
                    match resolved_execution {
                        Some(ResolvedExecution {
                            target: PinnedTarget::Existing(file),
                            ..
                        }) => file,
                        Some(_) => return Err("provider.protocol_error"),
                        None => open_relative(root, &parts, libc::O_RDONLY, 0).map_err(io_error)?,
                    }
                };
                if !file.metadata().map_err(io_error)?.is_file() {
                    return Err("provider.unavailable");
                }
                if !input["positioned"].is_null() {
                    if !input["bindingId"].is_string() {
                        return Err("provider.protocol_error");
                    }
                    let bytes = positioned::read(&file, &input["positioned"], maximum)?;
                    return encode_bytes(&bytes, &Value::Null);
                }
                let mut bytes = Vec::new();
                file.take(maximum as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(io_error)?;
                if bytes.len() > maximum {
                    return Err("resource.byte_limit");
                }
                encode_bytes(&bytes, &args["options"]["encoding"])
            }
            "filesystem.file.write" => {
                let bytes = decode_bytes(&args["data"], &args["options"]["encoding"])?;
                if bytes.len() > limit("maxWriteBytes")?.min(8 * 1024 * 1024) {
                    return Err("resource.byte_limit");
                }
                if let Some(id) = input["bindingId"].as_str() {
                    let (mut file, append) = self.resources.writable_file(id, root_id, &parts)?;
                    if input["positioned"].is_null() {
                        file.write_all(&bytes).map_err(io_error)?;
                    } else {
                        positioned::write(&file, &input["positioned"], &bytes, append)?;
                    }
                    return Ok(json!({}));
                }
                if !input["positioned"].is_null() {
                    return Err("provider.protocol_error");
                }
                if let Some(execution) = resolved_execution {
                    let flag = args["options"]["flag"].as_str().unwrap_or("w");
                    match execution.target {
                        PinnedTarget::Existing(mut file) if flag == "a" => {
                            file.write_all(&bytes).map_err(io_error)?;
                        }
                        PinnedTarget::Missing { name, parent } if matches!(flag, "w" | "wx") => {
                            write_atomic_missing(&parent, &name, &bytes)?;
                        }
                        PinnedTarget::Missing { name, parent } if matches!(flag, "a" | "ax") => {
                            write_append_missing(&parent, &name, &bytes)?;
                        }
                        _ => return Err("provider.unavailable"),
                    }
                    return Ok(json!({}));
                }
                let (directory, name) = parent(root, &parts).map_err(io_error)?;
                write_atomic(
                    &directory,
                    &name,
                    &bytes,
                    args["options"]["flag"].as_str().unwrap_or("w"),
                )?;
                Ok(json!({}))
            }
            "filesystem.metadata.access"
            | "filesystem.metadata.chmod"
            | "filesystem.metadata.utimes"
            | "filesystem.file.truncate"
            | "filesystem.file.sync"
            | "filesystem.file.datasync"
            | "filesystem.directory.sync" => {
                let action = action.ok_or("provider.protocol_error")?;
                let file = if let Some(id) = input["bindingId"].as_str() {
                    let right = match operation {
                        "filesystem.file.truncate" | "filesystem.metadata.utimes" => "write",
                        _ => "",
                    };
                    if operation == "filesystem.metadata.chmod" {
                        self.resources.metadata_target(id, root_id)?
                    } else if operation == "filesystem.directory.sync" {
                        self.resources.directory(id, root_id)?
                    } else {
                        self.resources.file(id, root_id, &parts, right)?
                    }
                } else {
                    match resolved_execution {
                        Some(ResolvedExecution {
                            target: PinnedTarget::Existing(file),
                            ..
                        }) => file,
                        Some(_) => return Err("provider.protocol_error"),
                        None if operation == "filesystem.metadata.access" => {
                            let mode = match &action {
                                metadata::Action::Access { mode } => *mode,
                                _ => return Err("provider.protocol_error"),
                            };
                            metadata::open_for_access(root, &parts, mode)?
                        }
                        None if operation == "filesystem.metadata.utimes" => {
                            metadata::open_for_utimes(root, &parts)?
                        }
                        None if operation == "filesystem.metadata.chmod" => {
                            metadata::open_for_chmod(root, &parts)?
                        }
                        None => {
                            let flags = match operation {
                                "filesystem.file.truncate" => libc::O_WRONLY,
                                "filesystem.directory.sync" => libc::O_RDONLY | libc::O_DIRECTORY,
                                _ => libc::O_RDONLY,
                            };
                            open_relative(root, &parts, flags, 0).map_err(io_error)?
                        }
                    }
                };
                match action {
                    metadata::Action::Access { mode } => {
                        let kind = file.metadata().map_err(io_error)?;
                        let mut exact_rights = Vec::new();
                        if mode == 0 || mode & 4 != 0 && kind.is_file() {
                            exact_rights.push("read");
                        }
                        if mode & 4 != 0 && kind.is_dir() || mode & 1 != 0 && kind.is_dir() {
                            exact_rights.push("list");
                        }
                        if mode & 1 != 0 && !kind.is_dir() {
                            return Err("capability.denied");
                        }
                        if mode & 2 != 0 {
                            exact_rights.push("write");
                        }
                        authorize(
                            root_id,
                            &parts,
                            &exact_rights,
                            root_policy,
                            constraints,
                            false,
                        )?;
                        metadata::access(&file, root, &parts, mode)
                    }
                    action => {
                        let kind = file.metadata().map_err(io_error)?;
                        if operation == "filesystem.directory.sync" && !kind.is_dir()
                            || matches!(
                                operation,
                                "filesystem.file.truncate"
                                    | "filesystem.file.sync"
                                    | "filesystem.file.datasync"
                            ) && !kind.is_file()
                            || operation == "filesystem.metadata.chmod"
                                && !(kind.is_file() || kind.is_dir())
                        {
                            return Err("provider.unavailable");
                        }
                        metadata::execute(&file, action, limit("maxWriteBytes")?)
                    }
                }
            }
            "filesystem.metadata.lstat"
                if input["bindingId"].is_null() && resolved_execution.is_none() =>
            {
                let (directory, name) = parent(root, &parts).map_err(io_error)?;
                let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
                if unsafe {
                    libc::fstatat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        info.as_mut_ptr(),
                        libc::AT_SYMLINK_NOFOLLOW,
                    )
                } != 0
                {
                    return Err(io_error(std::io::Error::last_os_error()));
                }
                metadata::stats_raw(&unsafe { info.assume_init() }, 0.0)
            }
            "filesystem.metadata.stat" | "filesystem.metadata.lstat" => {
                let file = if let Some(id) = input["bindingId"].as_str() {
                    self.resources.file(id, root_id, &parts, "")?
                } else {
                    match resolved_execution {
                        Some(ResolvedExecution {
                            target: PinnedTarget::Existing(file),
                            ..
                        }) => file,
                        Some(_) => return Err("provider.protocol_error"),
                        None => open_relative(root, &parts, libc::O_RDONLY, 0).map_err(io_error)?,
                    }
                };
                let info = file.metadata().map_err(io_error)?;
                if !(info.is_file() || info.is_dir()) {
                    return Err("provider.unavailable");
                }
                metadata::stats(&file)
            }
            "filesystem.directory.read" => {
                let maximum = limit("maxDirectoryEntries")?.min(65536);
                let with_types = args["options"]["withFileTypes"] == true;
                match resolved_execution {
                    Some(ResolvedExecution {
                        target: PinnedTarget::Existing(directory),
                        ..
                    }) => read_directory_file(&directory, maximum, with_types),
                    Some(_) => Err("provider.protocol_error"),
                    None => read_directory(root, &parts, maximum, with_types),
                }
            }
            "filesystem.directory.create" => {
                let recursive = args["options"]["recursive"] == true;
                if let Some(execution) = resolved_execution {
                    match execution.target {
                        PinnedTarget::Existing(_) if recursive => {
                            return Ok(json!({"kind":"undefined"}));
                        }
                        PinnedTarget::Missing { name, parent } => {
                            if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) }
                                != 0
                            {
                                return Err(io_error(std::io::Error::last_os_error()));
                            }
                            if !recursive {
                                return Ok(json!({}));
                            }
                            return Ok(
                                json!({"kind":"path","value":virtual_url(root_id, &execution.parts)?}),
                            );
                        }
                        _ => return Err("provider.unavailable"),
                    }
                }
                let mut created = None;
                let mut directory = root.try_clone().map_err(io_error)?;
                if !recursive {
                    let (parent, name) = parent(root, &parts).map_err(io_error)?;
                    if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
                        return Err(io_error(std::io::Error::last_os_error()));
                    }
                    return Ok(json!({}));
                }
                for (index, part) in parts.iter().enumerate() {
                    let name = child_name(part).map_err(io_error)?;
                    if unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) } == 0 {
                        created.get_or_insert(index);
                    } else if std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
                        return Err(io_error(std::io::Error::last_os_error()));
                    }
                    directory = open_relative(
                        &directory,
                        std::slice::from_ref(part),
                        libc::O_RDONLY | libc::O_DIRECTORY,
                        0,
                    )
                    .map_err(io_error)?;
                }
                if let Some(index) = created {
                    Ok(json!({"kind":"path","value":virtual_url(root_id, &parts[..=index])?}))
                } else {
                    Ok(json!({"kind":"undefined"}))
                }
            }
            "filesystem.entry.unlink" => {
                let (directory, name) = parent(root, &parts).map_err(io_error)?;
                if root_policy["symlinks"] == "deny" {
                    reject_symlink(&directory, &name).map_err(io_error)?;
                }
                let flags = match input["directoryRemove"].as_bool() {
                    Some(true) => libc::AT_REMOVEDIR,
                    Some(false) => 0,
                    None if input["directoryRemove"].is_null() => 0,
                    _ => return Err("argument.invalid"),
                };
                if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), flags) } != 0 {
                    return Err(io_error(std::io::Error::last_os_error()));
                }
                Ok(json!({}))
            }
            "filesystem.entry.rename" => {
                if root_policy["symlinks"] == "withinRoot" {
                    return Err("provider.unavailable");
                }
                if input["destinationRootId"] != root_id {
                    return Err("resource.cross_root");
                }
                let destination = segments(&input["destinationSegments"])?;
                let destination_constraints = if input["phase"] == "prepareRename" {
                    constraints
                } else {
                    &input["destinationConstraints"]
                };
                let allowed = destination_constraints["roots"]
                    .as_array()
                    .is_some_and(|roots| {
                        roots.iter().any(|root| {
                            root["rootId"] == root_id
                                && root["rights"].as_array().is_some_and(|rights| {
                                    rights.iter().any(|right| right == "move")
                                })
                                && segments(&root["pathPrefixSegments"])
                                    .is_ok_and(|prefix| destination.starts_with(&prefix))
                        })
                    });
                if !allowed {
                    return Err("capability.denied");
                }
                if input["phase"] == "prepareRename" {
                    self.renames.prepare(
                        root,
                        self.root_paths.get(root_id).ok_or("provider.unavailable")?,
                        root_id,
                        &parts,
                        &destination,
                        root_policy["symlinks"] == "withinRoot",
                    )
                } else {
                    let requested_source = if input["requestedSegments"].is_array() {
                        segments(&input["requestedSegments"])?
                    } else {
                        parts.clone()
                    };
                    let requested_destination = if input["requestedDestinationSegments"].is_array()
                    {
                        segments(&input["requestedDestinationSegments"])?
                    } else {
                        destination.clone()
                    };
                    self.renames.commit(
                        input["ticket"].as_str().ok_or("provider.protocol_error")?,
                        root_id,
                        &requested_source,
                        &requested_destination,
                        &parts,
                        &destination,
                    )
                }
            }
            _ => Err("provider.unavailable"),
        }
    }
}
impl NativeFilesystem {
    pub fn has_referenced_watchers(&self) -> bool {
        self.watchers.referenced()
    }
}
fn required_rights(operation: &str, arguments: &Value) -> Result<Vec<&'static str>> {
    match operation {
        "filesystem.file.open" => {
            Ok(resources::OpenFlag::parse(&arguments["flag"])?.required_rights())
        }
        "filesystem.file.close" => Ok(vec![]),
        "filesystem.file.read" | "filesystem.metadata.stat" | "filesystem.metadata.lstat" => {
            Ok(vec!["read"])
        }
        "filesystem.file.write" => Ok(vec!["write"]),
        "filesystem.file.truncate" | "filesystem.metadata.utimes" => Ok(vec!["write"]),
        "filesystem.metadata.chmod" => Ok(vec!["chmod"]),
        "filesystem.file.sync" | "filesystem.file.datasync" => Ok(vec![]),
        "filesystem.directory.open" => Ok(vec!["list"]),
        "filesystem.directory.sync" | "filesystem.directory.close" => Ok(vec![]),
        "filesystem.metadata.access" => {
            let mode = arguments["mode"].as_u64().ok_or("argument.invalid")?;
            if mode > 7 {
                return Err("argument.invalid");
            }
            let mut rights = Vec::new();
            if mode == 0 {
                rights.push("read");
            }
            if mode & 2 != 0 {
                rights.push("write");
            }
            if mode & 1 != 0 {
                rights.push("list");
            }
            Ok(rights)
        }
        "filesystem.directory.read" => Ok(vec!["list"]),
        "filesystem.directory.create" => Ok(vec!["create"]),
        "filesystem.entry.rename" => Ok(vec!["move"]),
        "filesystem.watch.subscribe" | "filesystem.watch.close" => Ok(vec!["watch"]),
        "filesystem.entry.unlink" => Ok(vec!["delete"]),
        _ => Err("provider.unavailable"),
    }
}

fn authorize<'a>(
    root_id: &str,
    parts: &[String],
    required: &[&str],
    root_policy: &'a Value,
    constraints: &'a Value,
    ignore_prefix: bool,
) -> Result<&'a Value> {
    let selected = constraints["roots"]
        .as_array()
        .and_then(|roots| {
            roots.iter().find(|root| {
                root["rootId"] == root_id
                    && root["rights"].as_array().is_some_and(|rights| {
                        required
                            .iter()
                            .all(|right| rights.iter().any(|item| item == right))
                    })
            })
        })
        .ok_or("capability.denied")?;
    if ignore_prefix {
        if root_policy["rights"].as_array().is_some_and(|rights| {
            required
                .iter()
                .all(|right| rights.iter().any(|item| item == right))
        }) && root_policy["symlinks"] == selected["symlinks"]
        {
            return Ok(selected);
        }
        return Err("capability.denied");
    }
    if !root_policy["rights"].as_array().is_some_and(|rights| {
        required
            .iter()
            .all(|right| rights.iter().any(|item| item == right))
    }) || root_policy["symlinks"] != selected["symlinks"]
        || !parts.starts_with(&segments(&selected["pathPrefixSegments"])?)
    {
        return Err("capability.denied");
    }
    Ok(selected)
}

fn resolution_behavior(operation: &str, arguments: &Value) -> Result<(bool, bool)> {
    match operation {
        "filesystem.file.open" => {
            let flag = resources::OpenFlag::parse(&arguments["flag"])?;
            Ok((true, flag.creates()))
        }
        "filesystem.file.write" => Ok((true, true)),
        "filesystem.directory.create" => Ok((true, true)),
        "filesystem.metadata.lstat" => Ok((false, false)),
        "filesystem.entry.unlink" => Err("provider.unavailable"),
        "filesystem.file.read"
        | "filesystem.metadata.stat"
        | "filesystem.metadata.access"
        | "filesystem.metadata.chmod"
        | "filesystem.metadata.utimes"
        | "filesystem.file.truncate"
        | "filesystem.directory.open"
        | "filesystem.directory.read"
        | "filesystem.watch.subscribe" => Ok((true, false)),
        _ => Err("provider.unavailable"),
    }
}
fn segments(value: &Value) -> Result<Vec<String>> {
    value
        .as_array()
        .ok_or("resource.invalid")?
        .iter()
        .map(|part| {
            let part = part.as_str().ok_or("resource.invalid")?;
            decode_canonical_segment(part).ok_or("resource.invalid")
        })
        .collect()
}

fn virtual_url(root_id: &str, native_parts: &[String]) -> Result<String> {
    let base = url::Url::parse(&format!("holo-fs://{root_id}/")).map_err(|_| "resource.invalid")?;
    Ok(format!(
        "{}{}",
        base.as_str(),
        native_parts
            .iter()
            .map(|part| encode_canonical_segment(part))
            .collect::<Vec<_>>()
            .join("/")
    ))
}
fn encode_bytes(bytes: &[u8], encoding: &Value) -> Result<Value> {
    match encoding.as_str() {
        Some("utf8" | "utf-8") => Ok(json!(String::from_utf8_lossy(bytes))),
        Some("base64") => Ok(json!(STANDARD.encode(bytes))),
        Some("hex") => Ok(json!(
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        )),
        None => Ok(
            json!({"base64":STANDARD.encode(bytes),"byteLength":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))}),
        ),
        _ => Err("argument.invalid"),
    }
}
fn decode_bytes(value: &Value, encoding: &Value) -> Result<Vec<u8>> {
    if let Some(text) = value.as_str() {
        return match encoding.as_str() {
            Some("base64") => STANDARD.decode(text).map_err(|_| "argument.invalid"),
            Some("hex") if text.len() % 2 == 0 && text.is_ascii() => (0..text.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|_| "argument.invalid"))
                .collect(),
            None | Some("utf8" | "utf-8") => Ok(text.as_bytes().to_vec()),
            _ => Err("argument.invalid"),
        };
    }
    let bytes = STANDARD
        .decode(value["base64"].as_str().ok_or("argument.invalid")?)
        .map_err(|_| "argument.invalid")?;
    if value["byteLength"].as_u64() != Some(bytes.len() as u64)
        || value["sha256"] != format!("{:x}", Sha256::digest(&bytes))
    {
        return Err("argument.invalid");
    }
    Ok(bytes)
}
fn write_atomic_missing(directory: &File, name: &CString, bytes: &[u8]) -> Result<()> {
    let temporary = format!(
        ".holo-{}-{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    );
    let temp_name = child_name(&temporary).map_err(io_error)?;
    let mut file = open_relative(
        directory,
        &[temporary],
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )
    .map_err(io_error)?;
    let result = (|| {
        file.write_all(bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        if unsafe {
            libc::linkat(
                directory.as_raw_fd(),
                temp_name.as_ptr(),
                directory.as_raw_fd(),
                name.as_ptr(),
                0,
            )
        } != 0
        {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        Ok(())
    })();
    unsafe { libc::unlinkat(directory.as_raw_fd(), temp_name.as_ptr(), 0) };
    result
}

fn write_append_missing(directory: &File, name: &CString, bytes: &[u8]) -> Result<()> {
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY
                | libc::O_CREAT
                | libc::O_EXCL
                | libc::O_APPEND
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK
                | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    file.write_all(bytes).map_err(io_error)
}

fn write_atomic(directory: &File, name: &CString, bytes: &[u8], flag: &str) -> Result<()> {
    reject_symlink(directory, name).map_err(io_error)?;
    if matches!(flag, "a" | "ax") {
        let flags = libc::O_WRONLY
            | libc::O_CREAT
            | libc::O_APPEND
            | if flag == "ax" { libc::O_EXCL } else { 0 };
        let part = name.to_str().map_err(|_| "resource.invalid")?.to_string();
        let mut file = open_relative(directory, &[part], flags, 0o600).map_err(io_error)?;
        if !file.metadata().map_err(io_error)?.is_file() {
            return Err("provider.unavailable");
        }
        file.write_all(bytes).map_err(io_error)?;
        return Ok(());
    }
    if !matches!(flag, "w" | "wx") {
        return Err("argument.invalid");
    }
    let temporary = format!(
        ".holo-{}-{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    );
    let temp_name = child_name(&temporary).map_err(io_error)?;
    let mut file = open_relative(
        directory,
        &[temporary],
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )
    .map_err(io_error)?;
    let result = (|| {
        file.write_all(bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        let status = if flag == "wx" {
            unsafe {
                libc::linkat(
                    directory.as_raw_fd(),
                    temp_name.as_ptr(),
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    0,
                )
            }
        } else {
            unsafe {
                libc::renameat(
                    directory.as_raw_fd(),
                    temp_name.as_ptr(),
                    directory.as_raw_fd(),
                    name.as_ptr(),
                )
            }
        };
        if status != 0 {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        Ok(())
    })();
    unsafe { libc::unlinkat(directory.as_raw_fd(), temp_name.as_ptr(), 0) };
    result
}
fn read_directory(
    root: &File,
    parts: &[String],
    maximum: usize,
    with_types: bool,
) -> Result<Value> {
    let directory =
        open_relative(root, parts, libc::O_RDONLY | libc::O_DIRECTORY, 0).map_err(io_error)?;
    read_directory_file(&directory, maximum, with_types)
}

fn directory_entry_kind(directory: &File, name: &CStr, d_type: u8) -> Result<&'static str> {
    match d_type {
        libc::DT_DIR => Ok("directory"),
        libc::DT_LNK => Ok("symlink"),
        libc::DT_REG => Ok("file"),
        libc::DT_UNKNOWN => {
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err(io_error(std::io::Error::last_os_error()));
            }
            match unsafe { stat.assume_init() }.st_mode & libc::S_IFMT {
                libc::S_IFDIR => Ok("directory"),
                libc::S_IFLNK => Ok("symlink"),
                libc::S_IFREG => Ok("file"),
                _ => Err("provider.unavailable"),
            }
        }
        _ => Err("provider.unavailable"),
    }
}

fn directory_entry_name(name: &CStr) -> Result<&str> {
    name.to_str().map_err(|_| "provider.unavailable")
}

fn read_directory_file(directory: &File, maximum: usize, with_types: bool) -> Result<Value> {
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe { libc::close(fd) };
        return Err("provider.unavailable");
    }
    let outcome = (|| {
        let mut entries = Vec::new();
        loop {
            #[cfg(target_os = "macos")]
            unsafe {
                *libc::__error() = 0;
            }
            #[cfg(target_os = "linux")]
            unsafe {
                *libc::__errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(0) {
                    return Err(io_error(error));
                }
                break;
            }
            let name_bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            let name = directory_entry_name(name_bytes)?;
            if matches!(name, "." | "..") {
                continue;
            }
            if entries.len() >= maximum {
                return Err("provider.quota");
            }
            let kind = directory_entry_kind(directory, name_bytes, unsafe { (*entry).d_type })?;
            entries.push((name.to_string(), kind));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(Value::Array(
            entries
                .into_iter()
                .map(|(name, kind)| {
                    if with_types {
                        json!({"name":name,"kind":kind})
                    } else {
                        json!(name)
                    }
                })
                .collect(),
        ))
    })();
    if unsafe { libc::closedir(stream) } != 0 && outcome.is_ok() {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    outcome
}

#[cfg(test)]
mod directory_entry_tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    #[test]
    fn unknown_dirent_type_uses_pinned_parent_and_rejects_special_entries() {
        let path = std::env::temp_dir().join(format!(
            "holo-directory-kind-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("file"), b"file").unwrap();
        fs::create_dir(path.join("subdir")).unwrap();
        symlink("file", path.join("link")).unwrap();
        let directory = File::open(&path).unwrap();
        assert_eq!(
            directory_entry_kind(&directory, c"file", libc::DT_UNKNOWN),
            Ok("file")
        );
        assert_eq!(
            directory_entry_kind(&directory, c"subdir", libc::DT_UNKNOWN),
            Ok("directory")
        );
        assert_eq!(
            directory_entry_kind(&directory, c"link", libc::DT_UNKNOWN),
            Ok("symlink")
        );
        assert_eq!(
            directory_entry_kind(&directory, c"missing", libc::DT_UNKNOWN),
            Err("resource.not_found")
        );
        assert_eq!(
            directory_entry_kind(&directory, c"file", libc::DT_FIFO),
            Err("provider.unavailable")
        );
        assert_eq!(directory_entry_name(c"x\xff"), Err("provider.unavailable"));
        drop(directory);
        fs::remove_dir_all(path).unwrap();
    }
}
