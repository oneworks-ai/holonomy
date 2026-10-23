use super::{
    Result, io_error,
    paths::{open_relative, parent, reject_symlink},
    resolution,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, ffi::CString, fs::File, os::fd::AsRawFd, path::PathBuf};

#[derive(Default)]
pub struct Renames {
    next: u64,
    pending: HashMap<String, Prepared>,
}
struct Prepared {
    root: File,
    root_id: String,
    requested_source: Vec<String>,
    requested_destination: Vec<String>,
    source: Vec<String>,
    destination: Vec<String>,
    source_parent: File,
    destination_parent: File,
    source_name: CString,
    destination_name: CString,
    evidence: Value,
    within_root: bool,
    root_paths: Vec<PathBuf>,
}
fn digest(value: Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).expect("Identity JSON"))
    )
}
fn identity(metadata: &libc::stat) -> String {
    digest(json!([
        "nativeFilesystemIdentityV1",
        metadata.st_dev.to_string(),
        metadata.st_ino.to_string(),
        metadata.st_mode.to_string()
    ]))
}
fn fd_stat(file: &File) -> Result<libc::stat> {
    let mut metadata = std::mem::MaybeUninit::uninit();
    if unsafe { libc::fstat(file.as_raw_fd(), metadata.as_mut_ptr()) } != 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(unsafe { metadata.assume_init() })
}
fn evidence(root: &File, root_id: &str, parts: &[String]) -> Result<Value> {
    let (directory, name) = parent(root, parts).map_err(io_error)?;
    reject_symlink(&directory, &name).map_err(io_error)?;
    let mut ancestors = vec![identity(&fd_stat(root)?)];
    for depth in 1..parts.len() {
        let ancestor = open_relative(root, &parts[..depth], libc::O_RDONLY | libc::O_DIRECTORY, 0)
            .map_err(io_error)?;
        ancestors.push(identity(&fd_stat(&ancestor)?));
    }
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    let status = unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    let (target_type, target) = if status == 0 {
        let metadata = unsafe { metadata.assume_init() };
        let kind = match metadata.st_mode & libc::S_IFMT {
            libc::S_IFREG => "file",
            libc::S_IFDIR => "directory",
            _ => return Err("resource.cross_root"),
        };
        (kind, identity(&metadata))
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(io_error(error));
        }
        (
            "missing",
            digest(json!([
                "nativeMissingFilesystemTargetV1",
                identity(&fd_stat(&directory)?),
                parts.last()
            ])),
        )
    };
    Ok(
        json!({"kind":"filesystemTarget","rootId":root_id,"ancestorIdentityDigests":ancestors,"targetIdentityDigest":target,"targetType":target_type}),
    )
}
impl Renames {
    pub fn prepare(
        &mut self,
        root: &File,
        root_paths: &[PathBuf],
        root_id: &str,
        source: &[String],
        destination: &[String],
        within_root: bool,
    ) -> Result<Value> {
        if self.pending.len() >= 64 {
            return Err("resource.handle_limit");
        }
        let (resolved_source, source_evidence, resolved_destination, destination_evidence) =
            if within_root {
                let source_resolution =
                    resolution::resolve(root, root_paths, root_id, source, false, false)?;
                let destination_resolution =
                    resolution::resolve(root, root_paths, root_id, destination, false, true)?;
                (
                    source_resolution.parts,
                    source_resolution.evidence,
                    destination_resolution.parts,
                    destination_resolution.evidence,
                )
            } else {
                (
                    source.to_vec(),
                    evidence(root, root_id, source)?,
                    destination.to_vec(),
                    evidence(root, root_id, destination)?,
                )
            };
        let (source_parent, source_name) = parent(root, &resolved_source).map_err(io_error)?;
        let (destination_parent, destination_name) =
            parent(root, &resolved_destination).map_err(io_error)?;
        let evidence = json!([source_evidence, destination_evidence]);
        if evidence[0]["ancestorIdentityDigests"]
            .as_array()
            .and_then(|items| items.last())
            != Some(&json!(identity(&fd_stat(&source_parent)?)))
            || evidence[1]["ancestorIdentityDigests"]
                .as_array()
                .and_then(|items| items.last())
                != Some(&json!(identity(&fd_stat(&destination_parent)?)))
        {
            return Err("resource.stale");
        }
        if evidence[0]["targetType"] == "missing" {
            return Err("resource.not_found");
        }
        self.next = self.next.checked_add(1).ok_or("resource.handle_limit")?;
        let ticket = format!("rename-{}", self.next);
        self.pending.insert(
            ticket.clone(),
            Prepared {
                root: root.try_clone().map_err(io_error)?,
                root_id: root_id.into(),
                requested_source: source.to_vec(),
                requested_destination: destination.to_vec(),
                source: resolved_source.clone(),
                destination: resolved_destination.clone(),
                source_parent,
                destination_parent,
                source_name,
                destination_name,
                evidence: evidence.clone(),
                within_root,
                root_paths: root_paths.to_vec(),
            },
        );
        Ok(json!({
            "ticket":ticket,
            "evidence":evidence,
            "resolvedSegments":[resolved_source,resolved_destination]
        }))
    }
    pub fn verify(&self, ticket: &str) -> Result<Value> {
        let prepared = self.pending.get(ticket).ok_or("resource.stale")?;
        if prepared.within_root {
            let source = resolution::resolve(
                &prepared.root,
                &prepared.root_paths,
                &prepared.root_id,
                &prepared.requested_source,
                false,
                false,
            )?;
            let destination = resolution::resolve(
                &prepared.root,
                &prepared.root_paths,
                &prepared.root_id,
                &prepared.requested_destination,
                false,
                true,
            )?;
            return Ok(json!({
                "evidence":[source.evidence,destination.evidence],
                "resolvedSegments":[source.parts,destination.parts]
            }));
        }
        Ok(json!({
            "evidence":[
                evidence(&prepared.root, &prepared.root_id, &prepared.source)?,
                evidence(&prepared.root, &prepared.root_id, &prepared.destination)?
            ],
            "resolvedSegments":[prepared.source,prepared.destination]
        }))
    }
    pub fn commit(
        &mut self,
        ticket: &str,
        root_id: &str,
        requested_source: &[String],
        requested_destination: &[String],
        resolved_source: &[String],
        resolved_destination: &[String],
    ) -> Result<Value> {
        let fresh = self.verify(ticket)?;
        let prepared = self.pending.remove(ticket).ok_or("resource.stale")?;
        if prepared.root_id != root_id
            || prepared.requested_source != requested_source
            || prepared.requested_destination != requested_destination
            || prepared.source != resolved_source
            || prepared.destination != resolved_destination
            || fresh["evidence"] != prepared.evidence
            || fresh["resolvedSegments"] != json!([prepared.source, prepared.destination])
        {
            return Err("resource.stale");
        }
        if unsafe {
            libc::renameat(
                prepared.source_parent.as_raw_fd(),
                prepared.source_name.as_ptr(),
                prepared.destination_parent.as_raw_fd(),
                prepared.destination_name.as_ptr(),
            )
        } != 0
        {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        Ok(json!({}))
    }
    pub fn close(&mut self, ticket: &str) {
        self.pending.remove(ticket);
    }
}
