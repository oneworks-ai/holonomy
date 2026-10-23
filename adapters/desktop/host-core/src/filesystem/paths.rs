use std::{
    ffi::CString,
    fs::File,
    os::fd::{AsRawFd, FromRawFd},
};

fn unescaped(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
        )
}

pub fn encode_canonical_segment(name: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(name.len());
    for &byte in name.as_bytes() {
        if unescaped(byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    encoded
}

pub fn decode_canonical_segment(segment: &str) -> Option<String> {
    if segment.is_empty() || segment.len() > 765 || !segment.is_ascii() {
        return None;
    }
    let escaped = segment.as_bytes();
    let mut bytes = Vec::with_capacity(escaped.len().min(255));
    let mut index = 0;
    while index < escaped.len() {
        if escaped[index] == b'%' {
            let hex = |digit| match digit {
                b'0'..=b'9' => Some(digit - b'0'),
                b'A'..=b'F' => Some(digit - b'A' + 10),
                _ => None,
            };
            let high = hex(*escaped.get(index + 1)?)?;
            let low = hex(*escaped.get(index + 2)?)?;
            bytes.push(high << 4 | low);
            index += 3;
        } else {
            if !unescaped(escaped[index]) {
                return None;
            }
            bytes.push(escaped[index]);
            index += 1;
        }
        if bytes.len() > 255 {
            return None;
        }
    }
    let name = String::from_utf8(bytes).ok()?;
    if name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return None;
    }
    (encode_canonical_segment(&name) == segment).then_some(name)
}

pub fn child_name(part: &str) -> std::io::Result<CString> {
    if part.is_empty() || part == "." || part == ".." || part.contains(['/', '\\', '\0']) {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    CString::new(part).map_err(|_| std::io::ErrorKind::InvalidInput.into())
}

pub fn reject_symlink(parent: &File, name: &CString) -> std::io::Result<()> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    let status = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if status != 0 {
        let error = std::io::Error::last_os_error();
        return if error.kind() == std::io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err(error)
        };
    }
    let metadata = unsafe { metadata.assume_init() };
    if metadata.st_mode & libc::S_IFMT == libc::S_IFLNK {
        return Err(std::io::Error::from_raw_os_error(libc::ELOOP));
    }
    Ok(())
}
pub fn open_relative(
    root: &File,
    parts: &[String],
    flags: i32,
    mode: libc::mode_t,
) -> std::io::Result<File> {
    let mut file = root.try_clone()?;
    for (index, part) in parts.iter().enumerate() {
        let name = child_name(part)?;
        reject_symlink(&file, &name)?;
        let selected = if index + 1 == parts.len() {
            flags
        } else {
            libc::O_RDONLY | libc::O_DIRECTORY
        };
        let fd = unsafe {
            libc::openat(
                file.as_raw_fd(),
                name.as_ptr(),
                selected | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                mode as libc::c_uint,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        file = unsafe { File::from_raw_fd(fd) };
    }
    Ok(file)
}
pub fn parent(root: &File, parts: &[String]) -> std::io::Result<(File, CString)> {
    let (last, parents) = parts
        .split_last()
        .ok_or(std::io::ErrorKind::PermissionDenied)?;
    Ok((
        open_relative(root, parents, libc::O_RDONLY | libc::O_DIRECTORY, 0)?,
        child_name(last)?,
    ))
}
