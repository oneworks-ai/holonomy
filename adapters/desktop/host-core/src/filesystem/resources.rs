use super::{Result, io_error, paths::open_relative, resolution::PinnedTarget};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::File,
    os::fd::{AsRawFd, FromRawFd},
};

struct Resource {
    file: File,
    root: String,
    kind: ResourceKind,
    read: bool,
    write: bool,
    append: bool,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum ResourceKind {
    File,
    Directory,
}
#[derive(Clone, Debug)]
pub(super) struct OpenFlag {
    access: OpenAccess,
    create: bool,
    exclusive: bool,
    truncate: bool,
    append: bool,
}

#[derive(Clone, Copy, Debug)]
enum OpenAccess {
    Read,
    Write,
    ReadWrite,
}

impl OpenFlag {
    pub(super) fn parse(value: &Value) -> Result<Self> {
        if let Some(flag) = value.as_str() {
            let (access, create, exclusive, truncate, append) = match flag {
                "r" => (OpenAccess::Read, false, false, false, false),
                "r+" => (OpenAccess::ReadWrite, false, false, false, false),
                "w" => (OpenAccess::Write, true, false, true, false),
                "w+" => (OpenAccess::ReadWrite, true, false, true, false),
                "wx" => (OpenAccess::Write, true, true, true, false),
                "wx+" => (OpenAccess::ReadWrite, true, true, true, false),
                "a" => (OpenAccess::Write, true, false, false, true),
                "a+" => (OpenAccess::ReadWrite, true, false, false, true),
                "ax" => (OpenAccess::Write, true, true, false, true),
                "ax+" => (OpenAccess::ReadWrite, true, true, false, true),
                _ => return Err("argument.invalid"),
            };
            return Ok(Self {
                access,
                create,
                exclusive,
                truncate,
                append,
            });
        }
        let object = value.as_object().ok_or("argument.invalid")?;
        if object.len() != 6
            || object.get("kind").and_then(Value::as_str) != Some("portable-open-v1")
        {
            return Err("argument.invalid");
        }
        let access = match object.get("access").and_then(Value::as_str) {
            Some("read") => OpenAccess::Read,
            Some("write") => OpenAccess::Write,
            Some("readWrite") => OpenAccess::ReadWrite,
            _ => return Err("argument.invalid"),
        };
        let boolean = |name| {
            object
                .get(name)
                .and_then(Value::as_bool)
                .ok_or("argument.invalid")
        };
        let create = boolean("create")?;
        let exclusive = boolean("exclusive")?;
        let truncate = boolean("truncate")?;
        let append = boolean("append")?;
        if exclusive && !create || matches!(access, OpenAccess::Read) && (truncate || append) {
            return Err("argument.invalid");
        }
        Ok(Self {
            access,
            create,
            exclusive,
            truncate,
            append,
        })
    }

    pub(super) fn required_rights(&self) -> Vec<&'static str> {
        let mut rights = self.handle_rights();
        if self.create && !rights.contains(&"write") {
            rights.push("write");
        }
        rights
    }

    fn handle_rights(&self) -> Vec<&'static str> {
        match self.access {
            OpenAccess::Read => vec!["read"],
            OpenAccess::Write => vec!["write"],
            OpenAccess::ReadWrite => vec!["read", "write"],
        }
    }

    fn access_bits(&self) -> i32 {
        match self.access {
            OpenAccess::Read => libc::O_RDONLY,
            OpenAccess::Write => libc::O_WRONLY,
            OpenAccess::ReadWrite => libc::O_RDWR,
        }
    }

    pub(super) fn existing_flags(&self) -> Result<i32> {
        if self.exclusive {
            return Err("resource.exists");
        }
        Ok(self.access_bits() | if self.append { libc::O_APPEND } else { 0 })
    }

    fn direct_flags(&self) -> i32 {
        self.access_bits()
            | if self.create { libc::O_CREAT } else { 0 }
            | if self.exclusive { libc::O_EXCL } else { 0 }
            | if self.truncate { libc::O_TRUNC } else { 0 }
            | if self.append { libc::O_APPEND } else { 0 }
    }

    pub(super) fn creates(&self) -> bool {
        self.create
    }
}
pub struct Resources {
    next: u32,
    entries: HashMap<String, Resource>,
}
impl Default for Resources {
    fn default() -> Self {
        Self {
            next: 10,
            entries: HashMap::new(),
        }
    }
}
impl Resources {
    fn ensure_capacity(&self, maximum: usize) -> Result<()> {
        if self.entries.len() >= maximum || self.next == u32::MAX {
            return Err("resource.handle_limit");
        }
        Ok(())
    }

    fn publish(&mut self, file: File, root_id: &str, flag: &OpenFlag) -> Result<Value> {
        let rights = flag.handle_rights();
        if !file.metadata().map_err(io_error)?.is_file() {
            return Err("provider.unavailable");
        }
        if flag.truncate {
            file.set_len(0).map_err(io_error)?;
        }
        let fd = self.next;
        self.next += 1;
        let binding = format!("fd-{fd}");
        self.entries.insert(
            binding.clone(),
            Resource {
                file,
                root: root_id.into(),
                kind: ResourceKind::File,
                read: rights.contains(&"read"),
                write: rights.contains(&"write"),
                append: flag.append,
            },
        );
        Ok(json!({"fd":fd,"bindingId":binding}))
    }

    pub fn open_resolved(
        &mut self,
        target: PinnedTarget,
        root_id: &str,
        flag: &OpenFlag,
        maximum: usize,
    ) -> Result<Value> {
        self.ensure_capacity(maximum)?;
        let file = match target {
            PinnedTarget::Existing(file) => file,
            PinnedTarget::Missing { name, parent } => {
                if !flag.creates() {
                    return Err("resource.not_found");
                }
                let flags = flag.access_bits()
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | if flag.append { libc::O_APPEND } else { 0 };
                let fd = unsafe {
                    libc::openat(
                        parent.as_raw_fd(),
                        name.as_ptr(),
                        flags | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                        0o600,
                    )
                };
                if fd < 0 {
                    return Err(io_error(std::io::Error::last_os_error()));
                }
                unsafe { File::from_raw_fd(fd) }
            }
        };
        self.publish(file, root_id, flag)
    }

    pub fn open(
        &mut self,
        root: &File,
        root_id: &str,
        parts: &[String],
        flag: &OpenFlag,
        maximum: usize,
    ) -> Result<Value> {
        self.ensure_capacity(maximum)?;
        let file = open_relative(root, parts, flag.direct_flags(), 0o600).map_err(io_error)?;
        self.publish(file, root_id, flag)
    }
    pub fn file(&self, id: &str, root: &str, _parts: &[String], right: &str) -> Result<File> {
        let resource = self.entries.get(id).ok_or("resource.stale")?;
        if resource.root != root
            || resource.kind != ResourceKind::File
            || right == "read" && !resource.read
            || right == "write" && !resource.write
        {
            return Err("capability.denied");
        }
        resource.file.try_clone().map_err(io_error)
    }
    pub fn metadata_target(&self, id: &str, root: &str) -> Result<File> {
        let resource = self.entries.get(id).ok_or("resource.stale")?;
        if resource.root != root {
            return Err("capability.denied");
        }
        // The retained file or directory descriptor identifies the object only.
        // Each metadata mutation must be authorized again by its own root right.
        resource.file.try_clone().map_err(io_error)
    }
    pub fn writable_file(&self, id: &str, root: &str, parts: &[String]) -> Result<(File, bool)> {
        let file = self.file(id, root, parts, "write")?;
        let append = self.entries.get(id).ok_or("resource.stale")?.append;
        Ok((file, append))
    }
    pub fn close(&mut self, id: &str) {
        self.entries.remove(id);
    }

    pub fn open_directory(
        &mut self,
        directory: File,
        root_id: &str,
        maximum: usize,
        max_entries: usize,
    ) -> Result<Value> {
        self.ensure_capacity(maximum)?;
        if !directory.metadata().map_err(io_error)?.is_dir() {
            return Err("provider.unavailable");
        }
        let entries = super::read_directory_file(&directory, max_entries, true)?;
        let binding = format!("dir-{}", self.next);
        self.next += 1;
        self.entries.insert(
            binding.clone(),
            Resource {
                file: directory,
                root: root_id.into(),
                kind: ResourceKind::Directory,
                read: false,
                write: false,
                append: false,
            },
        );
        Ok(json!({"bindingId":binding,"entries":entries}))
    }

    pub fn directory(&self, id: &str, root: &str) -> Result<File> {
        let resource = self.entries.get(id).ok_or("resource.stale")?;
        if resource.root != root || resource.kind != ResourceKind::Directory {
            return Err("capability.denied");
        }
        resource.file.try_clone().map_err(io_error)
    }

    pub fn close_directory(&mut self, id: &str, root: &str) -> Result<()> {
        let resource = self.entries.get(id).ok_or("resource.stale")?;
        if resource.root != root || resource.kind != ResourceKind::Directory {
            return Err("capability.denied");
        }
        self.entries.remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "holo-portable-open-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn portable(access: &str, create: bool, exclusive: bool, truncate: bool) -> OpenFlag {
        OpenFlag::parse(&json!({
            "kind":"portable-open-v1",
            "access":access,
            "create":create,
            "exclusive":exclusive,
            "truncate":truncate,
            "append":false
        }))
        .unwrap()
    }

    #[test]
    fn portable_flags_keep_create_truncate_and_handle_rights_separate() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("existing"), "PRESERVED_CONTENT").unwrap();
        let directory = File::open(&fixture.0).unwrap();
        let mut resources = Resources::default();

        let write_create = portable("write", true, false, false);
        assert_eq!(write_create.required_rights(), vec!["write"]);
        let existing = resources
            .open(
                &directory,
                "workspace",
                &["existing".into()],
                &write_create,
                8,
            )
            .unwrap();
        assert_eq!(
            fs::read(fixture.0.join("existing")).unwrap(),
            b"PRESERVED_CONTENT"
        );
        resources.close(existing["bindingId"].as_str().unwrap());

        let read_create = portable("read", true, false, false);
        assert_eq!(read_create.required_rights(), vec!["read", "write"]);
        let created = resources
            .open_resolved(
                PinnedTarget::Missing {
                    name: std::ffi::CString::new("created").unwrap(),
                    parent: directory.try_clone().unwrap(),
                },
                "workspace",
                &read_create,
                8,
            )
            .unwrap();
        let binding = created["bindingId"].as_str().unwrap();
        assert!(resources.file(binding, "workspace", &[], "read").is_ok());
        assert!(matches!(
            resources.file(binding, "workspace", &[], "write"),
            Err("capability.denied")
        ));
        resources.close(binding);
        assert_eq!(fs::read(fixture.0.join("created")).unwrap(), b"");

        let exclusive = portable("write", true, true, false);
        assert!(matches!(
            resources.open(&directory, "workspace", &["existing".into()], &exclusive, 8),
            Err("resource.exists")
        ));
        let truncate = portable("write", false, false, true);
        let opened = resources
            .open(&directory, "workspace", &["existing".into()], &truncate, 8)
            .unwrap();
        resources.close(opened["bindingId"].as_str().unwrap());
        assert_eq!(fs::read(fixture.0.join("existing")).unwrap(), b"");
        assert!(matches!(
            resources.open(&directory, "workspace", &["absent".into()], &truncate, 8),
            Err("resource.not_found")
        ));
        fs::write(fixture.0.join("existing"), "PREFIX").unwrap();
        let append = OpenFlag::parse(&json!({
            "kind":"portable-open-v1", "access":"write", "create":false,
            "exclusive":false, "truncate":false, "append":true
        }))
        .unwrap();
        let opened = resources
            .open(&directory, "workspace", &["existing".into()], &append, 8)
            .unwrap();
        let binding = opened["bindingId"].as_str().unwrap();
        let (file, append_mode) = resources.writable_file(binding, "workspace", &[]).unwrap();
        super::super::positioned::write(
            &file,
            &json!({ "kind":"positionedWrite", "offset":0 }),
            b"APPEND",
            append_mode,
        )
        .unwrap();
        resources.close(binding);
        assert_eq!(
            fs::read(fixture.0.join("existing")).unwrap(),
            b"PREFIXAPPEND"
        );
        fs::write(fixture.0.join("existing"), "OLD_CONTENT").unwrap();
        let truncate_append = OpenFlag::parse(&json!({
            "kind":"portable-open-v1", "access":"write", "create":true,
            "exclusive":false, "truncate":true, "append":true
        }))
        .unwrap();
        let opened = resources
            .open(
                &directory,
                "workspace",
                &["existing".into()],
                &truncate_append,
                8,
            )
            .unwrap();
        assert_eq!(fs::read(fixture.0.join("existing")).unwrap(), b"");
        let binding = opened["bindingId"].as_str().unwrap();
        let (file, append_mode) = resources.writable_file(binding, "workspace", &[]).unwrap();
        super::super::positioned::write(
            &file,
            &json!({ "kind":"positionedWrite", "offset":0 }),
            b"NEW",
            append_mode,
        )
        .unwrap();
        resources.close(binding);
        assert_eq!(fs::read(fixture.0.join("existing")).unwrap(), b"NEW");
        assert!(
            OpenFlag::parse(&json!({
                "kind":"portable-open-v1", "access":"read", "create":false,
                "exclusive":false, "truncate":true, "append":false
            }))
            .is_err()
        );
    }
}
