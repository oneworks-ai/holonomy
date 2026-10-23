use super::super::{Result, io_error};
use std::{
    collections::BTreeMap,
    ffi::{CStr, CString},
    fs::File,
    os::fd::AsRawFd,
};

#[derive(Clone, PartialEq, Eq)]
pub struct Stamp {
    pub dev: u64,
    pub inode: u64,
    pub mode: u32,
    size: i64,
    modified: i128,
    changed: i128,
}
impl Stamp {
    pub fn link(&self) -> bool {
        self.mode & libc::S_IFMT as u32 == libc::S_IFLNK as u32
    }
}
pub fn scan(directory: &File, maximum: usize) -> Result<BTreeMap<String, Stamp>> {
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
    let result = (|| {
        let mut entries = BTreeMap::new();
        loop {
            #[cfg(target_os = "macos")]
            unsafe {
                *libc::__error() = 0
            };
            #[cfg(target_os = "linux")]
            unsafe {
                *libc::__errno_location() = 0
            };
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if errno != 0 {
                    return Err("provider.unavailable");
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
                .to_str()
                .map_err(|_| "provider.unavailable")?;
            if matches!(name, "." | "..") {
                continue;
            }
            if entries.len() >= maximum.min(4096) {
                return Err("provider.quota");
            }
            let key = CString::new(name).map_err(|_| "resource.invalid")?;
            let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    directory.as_raw_fd(),
                    key.as_ptr(),
                    metadata.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::NotFound {
                    continue;
                }
                return Err(io_error(error));
            }
            let metadata = unsafe { metadata.assume_init() };
            entries.insert(
                name.into(),
                Stamp {
                    dev: metadata.st_dev as u64,
                    inode: metadata.st_ino,
                    mode: metadata.st_mode as u32,
                    size: metadata.st_size,
                    modified: metadata.st_mtime as i128 * 1_000_000_000
                        + metadata.st_mtime_nsec as i128,
                    changed: metadata.st_ctime as i128 * 1_000_000_000
                        + metadata.st_ctime_nsec as i128,
                },
            );
        }
        Ok(entries)
    })();
    unsafe { libc::closedir(stream) };
    result
}
