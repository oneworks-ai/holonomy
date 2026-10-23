use super::{Result, io_error, resources::OpenFlag};
use crate::filesystem::paths::{child_name, open_relative};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    ffi::CString,
    fs::File,
    os::fd::AsRawFd,
    path::{Component, Path, PathBuf},
};

const MAX_SYMLINKS: usize = 40;
const MAX_SEGMENTS: usize = 256;
const MAX_LINK_BYTES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Resolution {
    pub parts: Vec<String>,
    pub evidence: Value,
}

#[derive(Clone, Debug)]
pub struct ResolutionIntent {
    pub operation: String,
    pub flag: Option<Value>,
    pub recursive: bool,
}

pub enum PinnedTarget {
    Existing(File),
    Missing { name: CString, parent: File },
}

pub struct ResolvedExecution {
    pub parts: Vec<String>,
    pub target: PinnedTarget,
}

struct Prepared {
    intent: ResolutionIntent,
    root_id: String,
    requested: Vec<String>,
    resolution: Resolution,
    follow_final: bool,
    allow_missing: bool,
    root_paths: Vec<PathBuf>,
    pinned: Option<PinnedTarget>,
}

#[derive(Default)]
pub struct Resolutions {
    next: u64,
    pending: HashMap<String, Prepared>,
}

fn digest(value: Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).expect("filesystem identity JSON"))
    )
}

pub fn identity(metadata: &libc::stat) -> String {
    digest(json!([
        "nativeFilesystemIdentityV1",
        metadata.st_dev.to_string(),
        metadata.st_ino.to_string(),
        metadata.st_mode.to_string()
    ]))
}

pub fn fd_stat(file: &File) -> Result<libc::stat> {
    let mut metadata = std::mem::MaybeUninit::uninit();
    if unsafe { libc::fstat(file.as_raw_fd(), metadata.as_mut_ptr()) } != 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(unsafe { metadata.assume_init() })
}

fn child_stat(directory: &File, name: &std::ffi::CString) -> std::io::Result<libc::stat> {
    let mut metadata = std::mem::MaybeUninit::uninit();
    if unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { metadata.assume_init() })
}

fn read_link(directory: &File, name: &std::ffi::CString) -> Result<String> {
    let mut bytes = vec![0_u8; MAX_LINK_BYTES + 1];
    let length = unsafe {
        libc::readlinkat(
            directory.as_raw_fd(),
            name.as_ptr(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
        )
    };
    if length < 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let length = usize::try_from(length).map_err(|_| "resource.invalid")?;
    if length == 0 || length > MAX_LINK_BYTES {
        return Err("resource.invalid");
    }
    bytes.truncate(length);
    String::from_utf8(bytes).map_err(|_| "resource.invalid")
}

fn target_parts(
    root: &File,
    root_paths: &[PathBuf],
    base: &[String],
    target: &str,
) -> Result<Vec<String>> {
    let target_path = Path::new(target);
    let (mut output, parts): (Vec<String>, Vec<String>) = if target_path.is_absolute() {
        let (root_path, relative) = root_paths
            .iter()
            .find_map(|root_path| {
                target_path
                    .strip_prefix(root_path)
                    .ok()
                    .map(|relative| (root_path, relative))
            })
            .ok_or("resource.cross_root")?;
        use std::os::unix::fs::OpenOptionsExt;
        let current = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root_path)
            .map_err(io_error)?;
        if identity(&fd_stat(&current)?) != identity(&fd_stat(root)?) {
            return Err("resource.stale");
        }
        let mut parts = Vec::new();
        for component in relative.components() {
            match component {
                Component::Normal(value) => {
                    parts.push(value.to_str().ok_or("resource.invalid")?.to_string())
                }
                Component::CurDir => parts.push(".".into()),
                Component::ParentDir => parts.push("..".into()),
                Component::RootDir | Component::Prefix(_) => return Err("resource.cross_root"),
            }
        }
        (Vec::new(), parts)
    } else {
        (
            base.to_vec(),
            target.split('/').map(str::to_string).collect(),
        )
    };
    for part in parts {
        let part = part.as_str();
        match part {
            "" | "." => {}
            ".." => {
                output.pop().ok_or("resource.cross_root")?;
            }
            value if value.contains(['\\', '\0']) => return Err("resource.invalid"),
            value => output.push(value.into()),
        }
        if output.len() > MAX_SEGMENTS {
            return Err("resource.invalid");
        }
    }
    Ok(output)
}

fn evidence(root: &File, root_id: &str, parts: &[String]) -> Result<Value> {
    let mut ancestors = vec![identity(&fd_stat(root)?)];
    let mut directory = root.try_clone().map_err(io_error)?;
    if parts.is_empty() {
        return Ok(json!({
            "kind":"filesystemTarget",
            "rootId":root_id,
            "ancestorIdentityDigests":ancestors,
            "targetIdentityDigest":identity(&fd_stat(root)?),
            "targetType":"directory"
        }));
    }
    for part in &parts[..parts.len() - 1] {
        directory = open_relative(
            &directory,
            std::slice::from_ref(part),
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )
        .map_err(io_error)?;
        ancestors.push(identity(&fd_stat(&directory)?));
    }
    let name = child_name(parts.last().ok_or("resource.invalid")?).map_err(io_error)?;
    match child_stat(&directory, &name) {
        Ok(metadata) => {
            let target_type = match metadata.st_mode & libc::S_IFMT {
                libc::S_IFREG => "file",
                libc::S_IFDIR => "directory",
                libc::S_IFLNK => "symlink",
                _ => return Err("provider.unavailable"),
            };
            Ok(json!({
                "kind":"filesystemTarget",
                "rootId":root_id,
                "ancestorIdentityDigests":ancestors,
                "targetIdentityDigest":identity(&metadata),
                "targetType":target_type
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({
            "kind":"filesystemTarget",
            "rootId":root_id,
            "ancestorIdentityDigests":ancestors,
            "targetIdentityDigest":digest(json!([
                "nativeMissingFilesystemTargetV1",
                identity(&fd_stat(&directory)?),
                parts.last()
            ])),
            "targetType":"missing"
        })),
        Err(error) => Err(io_error(error)),
    }
}

fn missing_evidence(
    root: &File,
    root_id: &str,
    existing: &[String],
    missing: &[String],
) -> Result<Value> {
    let mut ancestors = vec![identity(&fd_stat(root)?)];
    let mut directory = root.try_clone().map_err(io_error)?;
    for part in existing {
        directory = open_relative(
            &directory,
            std::slice::from_ref(part),
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )
        .map_err(io_error)?;
        ancestors.push(identity(&fd_stat(&directory)?));
    }
    Ok(json!({
        "kind":"filesystemTarget",
        "rootId":root_id,
        "ancestorIdentityDigests":ancestors,
        "targetIdentityDigest":digest(json!([
            "nativeMissingFilesystemTargetV1",
            identity(&fd_stat(&directory)?),
            missing
        ])),
        "targetType":"missing"
    }))
}

fn open_flags(intent: &ResolutionIntent, target_type: &str) -> Result<i32> {
    match intent.operation.as_str() {
        "filesystem.metadata.lstat" => match target_type {
            "file" => Ok(libc::O_RDONLY),
            "directory" => Ok(libc::O_RDONLY | libc::O_DIRECTORY),
            _ => Err("provider.unavailable"),
        },
        "filesystem.file.read"
        | "filesystem.metadata.stat"
        | "filesystem.metadata.access"
        | "filesystem.metadata.chmod"
        | "filesystem.metadata.utimes" => Ok(libc::O_RDONLY),
        "filesystem.file.truncate" => Ok(libc::O_WRONLY),
        "filesystem.directory.open" => {
            if target_type != "directory" {
                return Err("provider.unavailable");
            }
            Ok(libc::O_RDONLY | libc::O_DIRECTORY)
        }
        "filesystem.directory.sync" => {
            if target_type != "directory" {
                return Err("provider.unavailable");
            }
            Ok(libc::O_RDONLY | libc::O_DIRECTORY)
        }
        "filesystem.directory.read" => {
            if target_type != "directory" {
                return Err("provider.unavailable");
            }
            Ok(libc::O_RDONLY | libc::O_DIRECTORY)
        }
        "filesystem.watch.subscribe" => match target_type {
            "directory" => Ok(libc::O_RDONLY | libc::O_DIRECTORY),
            "file" => Ok(libc::O_RDONLY),
            _ => Err("provider.unavailable"),
        },
        "filesystem.file.open" => {
            OpenFlag::parse(intent.flag.as_ref().ok_or("argument.invalid")?)?.existing_flags()
        }
        "filesystem.file.write" => match intent.flag.as_ref().and_then(Value::as_str) {
            Some("a") => Ok(libc::O_WRONLY | libc::O_APPEND),
            Some("ax") => Err("resource.exists"),
            Some("w" | "wx") => Err("provider.unavailable"),
            _ => Err("argument.invalid"),
        },
        "filesystem.directory.create" if intent.recursive && target_type == "directory" => {
            Ok(libc::O_RDONLY | libc::O_DIRECTORY)
        }
        "filesystem.directory.create" => Err("resource.exists"),
        _ => Err("provider.unavailable"),
    }
}

fn pin_target(
    root: &File,
    resolution: &Resolution,
    intent: &ResolutionIntent,
) -> Result<PinnedTarget> {
    let target_type = resolution.evidence["targetType"]
        .as_str()
        .ok_or("provider.protocol_error")?;
    if target_type == "missing" {
        if !matches!(
            intent.operation.as_str(),
            "filesystem.file.open" | "filesystem.file.write" | "filesystem.directory.create"
        ) {
            return Err("resource.not_found");
        }
        let ancestors = resolution.evidence["ancestorIdentityDigests"]
            .as_array()
            .ok_or("provider.protocol_error")?;
        if ancestors.len() != resolution.parts.len() {
            return Err("provider.unavailable");
        }
        let (parent, name) = super::paths::parent(root, &resolution.parts).map_err(io_error)?;
        let expected_parent = ancestors
            .last()
            .and_then(Value::as_str)
            .ok_or("provider.protocol_error")?;
        if identity(&fd_stat(&parent)?) != expected_parent {
            return Err("resource.stale");
        }
        match child_stat(&parent, &name) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return Err("resource.stale"),
            Err(error) => return Err(io_error(error)),
        }
        return Ok(PinnedTarget::Missing { name, parent });
    }
    let flags = open_flags(intent, target_type)?;
    let file = if intent.operation == "filesystem.metadata.utimes" {
        super::metadata::open_for_utimes(root, &resolution.parts)?
    } else if intent.operation == "filesystem.metadata.chmod" {
        super::metadata::open_for_chmod(root, &resolution.parts)?
    } else if intent.operation == "filesystem.metadata.access" {
        let mode = intent
            .flag
            .as_ref()
            .and_then(Value::as_i64)
            .ok_or("argument.invalid")?;
        super::metadata::open_for_access(
            root,
            &resolution.parts,
            i32::try_from(mode).map_err(|_| "argument.invalid")?,
        )?
    } else {
        open_relative(root, &resolution.parts, flags, 0).map_err(io_error)?
    };
    let expected = resolution.evidence["targetIdentityDigest"]
        .as_str()
        .ok_or("provider.protocol_error")?;
    if identity(&fd_stat(&file)?) != expected {
        return Err("resource.stale");
    }
    Ok(PinnedTarget::Existing(file))
}

pub fn resolve(
    root: &File,
    root_paths: &[PathBuf],
    root_id: &str,
    requested: &[String],
    follow_final: bool,
    allow_missing: bool,
) -> Result<Resolution> {
    let mut pending: VecDeque<String> = requested.iter().cloned().collect();
    let mut resolved = Vec::new();
    let mut followed = 0;
    while let Some(part) = pending.pop_front() {
        let directory = open_relative(root, &resolved, libc::O_RDONLY | libc::O_DIRECTORY, 0)
            .map_err(io_error)?;
        let name = child_name(&part).map_err(io_error)?;
        let metadata = match child_stat(&directory, &name) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing => {
                let existing = resolved.clone();
                let mut missing = vec![part];
                missing.extend(pending);
                resolved.extend(missing.iter().cloned());
                return Ok(Resolution {
                    parts: resolved,
                    evidence: missing_evidence(root, root_id, &existing, &missing)?,
                });
            }
            Err(error) => return Err(io_error(error)),
        };
        if metadata.st_mode & libc::S_IFMT == libc::S_IFLNK {
            if pending.is_empty() && !follow_final {
                resolved.push(part);
                break;
            }
            followed += 1;
            if followed > MAX_SYMLINKS {
                return Err("resource.cross_root");
            }
            let target = read_link(&directory, &name)?;
            let mut expanded: VecDeque<String> =
                target_parts(root, root_paths, &resolved, &target)?.into();
            expanded.append(&mut pending);
            if expanded.len() > MAX_SEGMENTS {
                return Err("resource.invalid");
            }
            pending = expanded;
            resolved.clear();
            continue;
        }
        if !pending.is_empty() && metadata.st_mode & libc::S_IFMT != libc::S_IFDIR {
            return Err("resource.not_found");
        }
        resolved.push(part);
    }
    let evidence = evidence(root, root_id, &resolved)?;
    if !allow_missing && evidence["targetType"] == "missing" {
        return Err("resource.not_found");
    }
    Ok(Resolution {
        parts: resolved,
        evidence,
    })
}

impl Resolutions {
    pub fn prepare(
        &mut self,
        root: &File,
        root_paths: &[PathBuf],
        root_id: &str,
        intent: ResolutionIntent,
        requested: &[String],
        behavior: (bool, bool),
    ) -> Result<Value> {
        if self.pending.len() >= 64 {
            return Err("resource.handle_limit");
        }
        let (follow_final, allow_missing) = behavior;
        let resolution = resolve(
            root,
            root_paths,
            root_id,
            requested,
            follow_final,
            allow_missing,
        )?;
        // The bounded lstat profile admits only pin-able ordinary objects. In
        // particular, do not publish evidence or follow a final symlink.
        if intent.operation == "filesystem.metadata.lstat" {
            open_flags(
                &intent,
                resolution.evidence["targetType"].as_str().unwrap_or(""),
            )?;
        }
        self.next = self.next.checked_add(1).ok_or("resource.handle_limit")?;
        let ticket = format!("resolution-{}", self.next);
        self.pending.insert(
            ticket.clone(),
            Prepared {
                intent,
                root_id: root_id.into(),
                requested: requested.to_vec(),
                resolution: resolution.clone(),
                follow_final,
                allow_missing,
                root_paths: root_paths.to_vec(),
                pinned: None,
            },
        );
        Ok(json!({
            "ticket":ticket,
            "resolvedSegments":resolution.parts,
            "evidence":resolution.evidence
        }))
    }

    pub fn verify(&mut self, root: &File, ticket: &str) -> Result<Value> {
        let prepared = self.pending.get_mut(ticket).ok_or("resource.stale")?;
        let resolution = resolve(
            root,
            &prepared.root_paths,
            &prepared.root_id,
            &prepared.requested,
            prepared.follow_final,
            prepared.allow_missing,
        )?;
        if prepared.intent.operation == "filesystem.metadata.lstat"
            && resolution != prepared.resolution
        {
            return Err("resource.stale");
        }
        let pinned = pin_target(root, &resolution, &prepared.intent)?;
        let final_resolution = resolve(
            root,
            &prepared.root_paths,
            &prepared.root_id,
            &prepared.requested,
            prepared.follow_final,
            prepared.allow_missing,
        )?;
        if final_resolution != resolution {
            return Err("resource.stale");
        }
        prepared.pinned = Some(pinned);
        Ok(json!({
            "resolvedSegments":final_resolution.parts,
            "evidence":final_resolution.evidence
        }))
    }

    pub fn consume(
        &mut self,
        ticket: &str,
        operation: &str,
        root_id: &str,
        requested: &[String],
        resolved: &[String],
    ) -> Result<ResolvedExecution> {
        let prepared = self.pending.remove(ticket).ok_or("resource.stale")?;
        if prepared.intent.operation != operation
            || prepared.root_id != root_id
            || prepared.requested != requested
            || prepared.resolution.parts != resolved
        {
            return Err("resource.stale");
        }
        Ok(ResolvedExecution {
            parts: prepared.resolution.parts,
            target: prepared.pinned.ok_or("provider.protocol_error")?,
        })
    }

    pub fn close(&mut self, ticket: &str) {
        self.pending.remove(ticket);
    }
}
