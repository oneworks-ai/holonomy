use super::{
    Result, io_error,
    paths::{open_relative, parent},
    resolution::fd_stat,
};
use serde_json::{Value, json};
use std::{fs::File, os::fd::AsRawFd};

const MAX_TIME_SECONDS: u64 = 253_402_300_799;
const MAX_SAFE_SIZE: u64 = 9_007_199_254_740_991;

pub(super) enum Action {
    Access {
        mode: i32,
    },
    Chmod {
        mode: libc::mode_t,
        readback: bool,
        expected_kind: Option<&'static str>,
    },
    Truncate {
        len: u64,
        readback: bool,
    },
    Utimes {
        times: [libc::timespec; 2],
        readback: bool,
    },
    Sync {
        data_only: bool,
    },
}

fn exact(value: &Value, required: &[&str], optional: &[&str]) -> Result<()> {
    let object = value.as_object().ok_or("argument.invalid")?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err("argument.invalid");
    }
    Ok(())
}

fn source_readback(args: &Value, linux_process: bool) -> Result<bool> {
    match args.get("readback") {
        None => Ok(false),
        Some(Value::Bool(true)) if linux_process => Ok(true),
        Some(Value::Bool(true)) => Err("capability.denied"),
        _ => Err("argument.invalid"),
    }
}

fn time_spec(value: &Value, linux_process: bool) -> Result<libc::timespec> {
    match value.get("kind").and_then(Value::as_str) {
        Some("now") | Some("omit") if linux_process => {
            exact(value, &["kind"], &[])?;
            Ok(libc::timespec {
                tv_sec: 0,
                tv_nsec: if value["kind"] == "now" {
                    libc::UTIME_NOW
                } else {
                    libc::UTIME_OMIT
                },
            })
        }
        Some("now" | "omit") => Err("capability.denied"),
        Some("set") => {
            exact(value, &["kind", "seconds", "nanoseconds"], &[])?;
            let seconds = value["seconds"].as_u64().ok_or("argument.invalid")?;
            let nanoseconds = value["nanoseconds"].as_u64().ok_or("argument.invalid")?;
            if seconds > MAX_TIME_SECONDS || nanoseconds >= 1_000_000_000 {
                return Err("argument.invalid");
            }
            Ok(libc::timespec {
                tv_sec: seconds.try_into().map_err(|_| "argument.invalid")?,
                tv_nsec: nanoseconds.try_into().map_err(|_| "argument.invalid")?,
            })
        }
        _ => Err("argument.invalid"),
    }
}

pub(super) fn validate_directory_resource(
    operation: &str,
    args: &Value,
    binding: bool,
    linux_process: bool,
) -> Result<()> {
    if !matches!(
        operation,
        "filesystem.directory.open" | "filesystem.directory.close"
    ) {
        return Ok(());
    }
    if !linux_process {
        return Err("capability.denied");
    }
    if operation == "filesystem.directory.open" {
        if binding {
            return Err("argument.invalid");
        }
        exact(args, &["path"], &[])?;
        if !args["path"].is_string() {
            return Err("argument.invalid");
        }
    } else {
        if !binding {
            return Err("resource.stale");
        }
        exact(args, &[], &[])?;
    }
    Ok(())
}

pub(super) fn parse(
    operation: &str,
    args: &Value,
    binding: bool,
    linux_process: bool,
) -> Result<Option<Action>> {
    let action = match operation {
        "filesystem.metadata.access" => {
            if binding {
                return Err("argument.invalid");
            }
            exact(args, &["path", "mode"], &[])?;
            let mode = args["mode"].as_u64().ok_or("argument.invalid")?;
            if mode > 7 || !args["path"].is_string() {
                return Err("argument.invalid");
            }
            Action::Access { mode: mode as i32 }
        }
        "filesystem.metadata.chmod" => {
            exact(
                args,
                if binding {
                    &["mode"]
                } else {
                    &["path", "mode"]
                },
                &["readback", "expectedKind"],
            )?;
            if !binding && !args["path"].is_string() {
                return Err("argument.invalid");
            }
            let mode = args["mode"].as_u64().ok_or("argument.invalid")?;
            if mode > 0o777 {
                return Err("argument.invalid");
            }
            let readback = source_readback(args, linux_process)?;
            let expected_kind = match args.get("expectedKind") {
                None => None,
                Some(value) if readback && linux_process => match value.as_str() {
                    Some("file") => Some("file"),
                    Some("directory") => Some("directory"),
                    _ => return Err("argument.invalid"),
                },
                Some(_) => return Err("argument.invalid"),
            };
            Action::Chmod {
                mode: mode as libc::mode_t,
                readback,
                expected_kind,
            }
        }
        "filesystem.file.truncate" => {
            exact(
                args,
                if binding { &["len"] } else { &["path", "len"] },
                &["readback"],
            )?;
            if !binding && !args["path"].is_string() {
                return Err("argument.invalid");
            }
            let len = args["len"].as_u64().ok_or("argument.invalid")?;
            if len > MAX_SAFE_SIZE {
                return Err("argument.invalid");
            }
            Action::Truncate {
                len,
                readback: source_readback(args, linux_process)?,
            }
        }
        "filesystem.metadata.utimes" => {
            exact(
                args,
                if binding {
                    &["atime", "mtime"]
                } else {
                    &["path", "atime", "mtime"]
                },
                &["readback"],
            )?;
            if !binding && !args["path"].is_string() {
                return Err("argument.invalid");
            }
            Action::Utimes {
                times: [
                    time_spec(&args["atime"], linux_process)?,
                    time_spec(&args["mtime"], linux_process)?,
                ],
                readback: source_readback(args, linux_process)?,
            }
        }
        "filesystem.file.sync" | "filesystem.file.datasync" => {
            if !binding {
                return Err("resource.stale");
            }
            exact(args, &[], &[])?;
            Action::Sync {
                data_only: operation == "filesystem.file.datasync",
            }
        }
        "filesystem.directory.sync" => {
            if !binding || !linux_process {
                return Err("capability.denied");
            }
            exact(args, &["dataOnly"], &[])?;
            Action::Sync {
                data_only: args["dataOnly"].as_bool().ok_or("argument.invalid")?,
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(action))
}

pub(super) fn access(file: &File, root: &File, parts: &[String], mode: i32) -> Result<Value> {
    let original = fd_stat(file)?;
    match original.st_mode & libc::S_IFMT {
        libc::S_IFDIR => {
            // The dot lookup is relative to the pinned directory, including after a rename.
            if unsafe { libc::faccessat(file.as_raw_fd(), c".".as_ptr(), mode, 0) } != 0 {
                return Err(io_error(std::io::Error::last_os_error()));
            }
        }
        libc::S_IFREG => {
            if mode & libc::X_OK != 0 {
                return Err("capability.denied");
            }
            for (bit, flags) in [(libc::R_OK, libc::O_RDONLY), (libc::W_OK, libc::O_WRONLY)] {
                if mode & bit == 0 {
                    continue;
                }
                let checked = open_relative(root, parts, flags, 0).map_err(io_error)?;
                let actual = fd_stat(&checked)?;
                if actual.st_dev != original.st_dev || actual.st_ino != original.st_ino {
                    return Err("resource.stale");
                }
            }
        }
        _ => return Err("provider.unavailable"),
    }
    Ok(json!({}))
}

pub(super) fn open_for_access(root: &File, parts: &[String], mode: i32) -> Result<File> {
    #[cfg(target_os = "linux")]
    {
        let _ = mode;
        return open_relative(root, parts, libc::O_PATH, 0).map_err(io_error);
    }
    #[cfg(target_os = "macos")]
    let candidates: &[i32] = if mode & libc::R_OK != 0 {
        &[libc::O_RDONLY]
    } else if mode & libc::X_OK != 0 {
        &[libc::O_SEARCH, libc::O_WRONLY, libc::O_RDONLY, libc::O_EXEC]
    } else if mode & libc::W_OK != 0 {
        &[libc::O_WRONLY, libc::O_SEARCH]
    } else {
        &[libc::O_RDONLY, libc::O_WRONLY, libc::O_SEARCH, libc::O_EXEC]
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let candidates: &[i32] = &[libc::O_RDONLY];
    #[cfg(not(target_os = "linux"))]
    {
        let mut first_error = None;
        for flags in candidates {
            match open_relative(root, parts, *flags, 0) {
                Ok(file) => return Ok(file),
                Err(error)
                    if matches!(
                        error.raw_os_error(),
                        Some(libc::EACCES | libc::EPERM | libc::EISDIR | libc::ENOTDIR)
                    ) =>
                {
                    first_error.get_or_insert(error);
                }
                Err(error) => return Err(io_error(error)),
            }
        }
        Err(io_error(first_error.ok_or("provider.unavailable")?))
    }
}

pub(super) fn open_for_utimes(root: &File, parts: &[String]) -> Result<File> {
    let expected = if parts.is_empty() {
        fd_stat(root)?
    } else {
        let (directory, name) = parent(root, parts).map_err(io_error)?;
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
        unsafe { stat.assume_init() }
    };
    let mut first_error = None;
    for flags in [libc::O_RDONLY, libc::O_WRONLY] {
        match open_relative(root, parts, flags, 0) {
            Ok(file) => {
                let actual = fd_stat(&file)?;
                if actual.st_dev != expected.st_dev
                    || actual.st_ino != expected.st_ino
                    || actual.st_mode & libc::S_IFMT != expected.st_mode & libc::S_IFMT
                {
                    return Err("resource.stale");
                }
                return Ok(file);
            }
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::EACCES | libc::EPERM | libc::EISDIR)
                ) =>
            {
                first_error.get_or_insert(error);
            }
            Err(error) => return Err(io_error(error)),
        }
    }
    Err(io_error(first_error.ok_or("provider.unavailable")?))
}

pub(super) fn open_for_chmod(root: &File, parts: &[String]) -> Result<File> {
    // fchmod must operate on an actual descriptor. Reuse the metadata mutation
    // opener's nofollow and inode comparison instead of falling back to chmod(path).
    open_for_utimes(root, parts)
}

pub(super) fn execute(file: &File, action: Action, max_write_bytes: usize) -> Result<Value> {
    match action {
        Action::Access { .. } => Err("provider.protocol_error"),
        Action::Chmod {
            mode,
            readback,
            expected_kind,
        } => {
            if let Some(expected_kind) = expected_kind {
                let actual_type = fd_stat(file)?.st_mode & libc::S_IFMT;
                if expected_kind == "file" && actual_type != libc::S_IFREG
                    || expected_kind == "directory" && actual_type != libc::S_IFDIR
                {
                    return Err("resource.invalid");
                }
            }
            if readback {
                stats(file)?;
            }
            if unsafe { libc::fchmod(file.as_raw_fd(), mode) } != 0 {
                return Err(io_error(std::io::Error::last_os_error()));
            }
            if readback { stats(file) } else { Ok(json!({})) }
        }
        Action::Truncate { len, readback } => {
            if len > max_write_bytes as u64 {
                return Err("resource.byte_limit");
            }
            if readback {
                stats(file)?;
            }
            file.set_len(len).map_err(io_error)?;
            if readback { stats(file) } else { Ok(json!({})) }
        }
        Action::Utimes { times, readback } => {
            if readback {
                stats(file)?;
            }
            if unsafe { libc::futimens(file.as_raw_fd(), times.as_ptr()) } != 0 {
                return Err(io_error(std::io::Error::last_os_error()));
            }
            if readback { stats(file) } else { Ok(json!({})) }
        }
        Action::Sync { data_only } => {
            if data_only {
                file.sync_data().map_err(io_error)?;
            } else {
                file.sync_all().map_err(io_error)?;
            }
            Ok(json!({}))
        }
    }
}

fn epoch_ns(seconds: libc::time_t, nanoseconds: libc::c_long) -> i128 {
    i128::from(seconds) * 1_000_000_000 + i128::from(nanoseconds)
}

pub(super) fn stats(file: &File) -> Result<Value> {
    let raw = fd_stat(file)?;
    let birthtime_ms = file
        .metadata()
        .ok()
        .and_then(|meta| meta.created().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    stats_raw(&raw, birthtime_ms)
}

pub(super) fn stats_raw(raw: &libc::stat, birthtime_ms: f64) -> Result<Value> {
    let kind = match raw.st_mode & libc::S_IFMT {
        libc::S_IFREG => "file",
        libc::S_IFDIR => "directory",
        libc::S_IFLNK => "symlink",
        _ => return Err("provider.unavailable"),
    };
    let size = u64::try_from(raw.st_size).map_err(|_| "provider.unavailable")?;
    if size > MAX_SAFE_SIZE {
        return Err("resource.byte_limit");
    }
    let atime_ns = epoch_ns(raw.st_atime, raw.st_atime_nsec);
    let mtime_ns = epoch_ns(raw.st_mtime, raw.st_mtime_nsec);
    let ctime_ns = epoch_ns(raw.st_ctime, raw.st_ctime_nsec);
    Ok(json!({
        "birthtimeMs":birthtime_ms,
        "atimeMs":atime_ns as f64 / 1_000_000.0,
        "mtimeMs":mtime_ns as f64 / 1_000_000.0,
        "ctimeMs":ctime_ns as f64 / 1_000_000.0,
        "atimeNs":atime_ns.to_string(),
        "mtimeNs":mtime_ns.to_string(),
        "ctimeNs":ctime_ns.to_string(),
        "kind":kind,
        "mode":raw.st_mode as u32,
        "size":size
    }))
}
