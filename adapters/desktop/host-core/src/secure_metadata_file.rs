//! Shared descriptor-pinned, owner-private metadata file primitive.
//! Audit and observer output use the same path, inode, lock and role checks.
use crate::SourceAdmission;
use std::{
    ffi::{CString, OsString},
    fs::{File, OpenOptions},
    io::Write,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
};

#[derive(Debug)]
pub(crate) struct PrivateMetadataFile {
    file: File,
    parent: File,
    logical_path: PathBuf,
    physical_path: PathBuf,
    parent_path: PathBuf,
    name: OsString,
    device: u64,
    inode: u64,
    max_bytes: u64,
    exact_mode: bool,
}

impl PrivateMetadataFile {
    pub(crate) fn open(
        path: &Path,
        max_bytes: u64,
        admission: &SourceAdmission,
        exact_mode: bool,
    ) -> Result<Self, String> {
        if !path.is_absolute() || path.as_os_str().len() > 4096 {
            return Err("Invalid private metadata path".into());
        }
        let physical = physical_path(path)?;
        let parent_path = physical
            .parent()
            .ok_or("Invalid private metadata path")?
            .to_path_buf();
        let parent = open_trusted_parent(&parent_path, exact_mode)?;
        let name = physical
            .file_name()
            .ok_or("Invalid private metadata path")?
            .to_os_string();
        let leaf =
            CString::new(name.as_encoded_bytes()).map_err(|_| "Invalid private metadata path")?;
        admission.audit_slot_available(&parent, &name)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                leaf.as_ptr(),
                libc::O_RDWR
                    | libc::O_APPEND
                    | libc::O_CREAT
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err("Private metadata file is unavailable".into());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file
            .metadata()
            .map_err(|_| "Private metadata file is unavailable")?;
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || (exact_mode && metadata.mode() & 0o777 != 0o600)
            || metadata.nlink() != 1
            || metadata.len() > max_bytes
            || unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
        {
            return Err(
                "Private metadata file must be bounded, private and exclusively owned".into(),
            );
        }
        let output = Self {
            file,
            parent,
            logical_path: path.to_path_buf(),
            physical_path: physical,
            parent_path,
            name,
            device: metadata.dev(),
            inode: metadata.ino(),
            max_bytes,
            exact_mode,
        };
        output.check_identity(0)?;
        Ok(output)
    }

    pub(crate) fn file(&self) -> &File {
        &self.file
    }

    pub(crate) fn label(&self, admission: &SourceAdmission) -> Result<(), String> {
        self.check_identity(0)?;
        admission.reserve_namespace(&self.logical_path)?;
        admission.reserve_namespace(&self.physical_path)?;
        admission.audit(&self.parent, &self.name, &self.file)?;
        self.parent
            .sync_all()
            .map_err(|_| "Private metadata directory sync failed".into())
    }

    pub(crate) fn append(&mut self, line: &[u8], sync: bool) -> Result<(), String> {
        self.check_identity(line.len() as u64)?;
        self.file
            .write_all(line)
            .map_err(|_| "Private metadata append failed")?;
        if sync {
            self.file
                .sync_data()
                .map_err(|_| "Private metadata sync failed")?;
        }
        Ok(())
    }

    fn check_identity(&self, additional: u64) -> Result<(), String> {
        let current_parent = open_trusted_parent(&self.parent_path, self.exact_mode)?;
        let current_parent_metadata = current_parent
            .metadata()
            .map_err(|_| "Private metadata parent is unavailable")?;
        let pinned_parent_metadata = self
            .parent
            .metadata()
            .map_err(|_| "Private metadata parent is unavailable")?;
        if current_parent_metadata.dev() != pinned_parent_metadata.dev()
            || current_parent_metadata.ino() != pinned_parent_metadata.ino()
        {
            return Err("Private metadata parent changed".into());
        }
        let metadata = self
            .file
            .metadata()
            .map_err(|_| "Private metadata identity unavailable")?;
        if !metadata.is_file()
            || metadata.dev() != self.device
            || metadata.ino() != self.inode
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || (self.exact_mode && metadata.mode() & 0o777 != 0o600)
            || metadata.nlink() != 1
            || metadata
                .len()
                .checked_add(additional)
                .is_none_or(|size| size > self.max_bytes)
        {
            return Err("Private metadata identity or size changed".into());
        }
        let name = CString::new(self.name.as_encoded_bytes())
            .map_err(|_| "Invalid private metadata path")?;
        let mut current = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                self.parent.as_raw_fd(),
                name.as_ptr(),
                current.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err("Private metadata path changed".into());
        }
        let current = unsafe { current.assume_init() };
        if current.st_dev as u64 != self.device || current.st_ino != self.inode {
            return Err("Private metadata path changed".into());
        }
        Ok(())
    }
}

fn open_trusted_parent(path: &Path, exact_mode: bool) -> Result<File, String> {
    let mut parent = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")
        .map_err(|_| "Private metadata parent is unavailable")?;
    for component in path.components() {
        let Component::Normal(part) = component else {
            if component == Component::RootDir {
                continue;
            }
            return Err("Invalid private metadata parent".into());
        };
        let name =
            CString::new(part.as_encoded_bytes()).map_err(|_| "Invalid private metadata parent")?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err("Private metadata parent is unavailable".into());
        }
        parent = unsafe { File::from_raw_fd(fd) };
        let metadata = parent
            .metadata()
            .map_err(|_| "Private metadata parent is unavailable")?;
        if (metadata.uid() != 0 && metadata.uid() != unsafe { libc::geteuid() })
            || (metadata.mode() & 0o022 != 0 && metadata.mode() & 0o1000 == 0)
        {
            return Err("Private metadata parent must be owner controlled".into());
        }
    }
    let metadata = parent
        .metadata()
        .map_err(|_| "Private metadata parent is unavailable")?;
    if metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || (exact_mode && metadata.mode() & 0o777 != 0o700)
    {
        return Err("Private metadata directory must be owner private".into());
    }
    Ok(parent)
}

fn physical_path(path: &Path) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    if let Ok(relative) = path.strip_prefix("/var") {
        let link = std::fs::symlink_metadata("/var")
            .map_err(|_| "Private metadata parent is unavailable")?;
        let private = std::fs::symlink_metadata("/private")
            .map_err(|_| "Private metadata parent is unavailable")?;
        let target = std::fs::symlink_metadata("/private/var")
            .map_err(|_| "Private metadata parent is unavailable")?;
        if link.file_type().is_symlink()
            && link.uid() == 0
            && private.is_dir()
            && private.uid() == 0
            && private.mode() & 0o022 == 0
            && target.is_dir()
            && target.uid() == 0
            && target.mode() & 0o022 == 0
            && std::fs::canonicalize("/var").ok().as_deref() == Some(Path::new("/private/var"))
        {
            return Ok(Path::new("/private/var").join(relative));
        }
    }
    Ok(path.to_path_buf())
}
