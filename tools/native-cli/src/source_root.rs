//! Host-only selection of the existing private launch-v2 source namespace.
use std::path::{Path, PathBuf};

pub(crate) fn select(value: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(value)
        .canonicalize()
        .map_err(|_| "Selected module root is unavailable")?;
    if !root.is_dir() {
        return Err("Selected module root must be a directory".into());
    }
    if root
        .to_str()
        .is_none_or(|text| text.len() > 4096 || text.contains('\0'))
    {
        return Err("Invalid selected module root".into());
    }
    Ok(root)
}

pub(crate) fn validate_entries(entries: &[PathBuf], root: Option<&Path>) -> Result<(), String> {
    let Some(root) = root else { return Ok(()) };
    for entry in entries {
        if !entry.starts_with(root) || entry == root {
            return Err("Entry file is outside selected module root".into());
        }
        if !entry.is_file() {
            return Err("Entry file must be a regular file".into());
        }
    }
    Ok(())
}
