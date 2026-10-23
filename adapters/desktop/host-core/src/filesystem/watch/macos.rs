use super::{
    super::{Result, io_error, paths::open_relative},
    snapshot::{Stamp, scan},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    ptr,
};

struct Child {
    file: File,
    token: u64,
    dev: u64,
    inode: u64,
}
struct Watch {
    file: File,
    token: u64,
    persistent: bool,
    name: Option<String>,
    maximum_entries: usize,
    snapshot: Option<BTreeMap<String, Stamp>>,
    children: BTreeMap<String, Child>,
}
struct Node {
    watch: u32,
    name: Option<String>,
}
#[derive(Default)]
pub struct Watchers {
    queue: Option<File>,
    next: u32,
    next_node: u64,
    entries: HashMap<u32, Watch>,
    nodes: HashMap<u64, Node>,
}
impl Watchers {
    fn register(&mut self, file: &File, watch: u32, name: Option<String>) -> Result<u64> {
        if self.nodes.len() >= 4096 {
            return Err("resource.handle_limit");
        }
        if self.queue.is_none() {
            let fd = unsafe { libc::kqueue() };
            if fd < 0 {
                return Err(io_error(std::io::Error::last_os_error()));
            }
            let queue = unsafe { File::from_raw_fd(fd) };
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
                return Err(io_error(std::io::Error::last_os_error()));
            }
            self.queue = Some(queue);
        }
        self.next_node = self
            .next_node
            .checked_add(1)
            .ok_or("resource.handle_limit")?;
        let token = self.next_node;
        let event = libc::kevent {
            ident: file.as_raw_fd() as libc::uintptr_t,
            filter: libc::EVFILT_VNODE,
            flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_CLEAR,
            fflags: libc::NOTE_WRITE
                | libc::NOTE_EXTEND
                | libc::NOTE_ATTRIB
                | libc::NOTE_DELETE
                | libc::NOTE_RENAME
                | libc::NOTE_REVOKE,
            data: 0,
            udata: token as usize as *mut libc::c_void,
        };
        if unsafe {
            libc::kevent(
                self.queue.as_ref().unwrap().as_raw_fd(),
                &event,
                1,
                ptr::null_mut(),
                0,
                ptr::null(),
            )
        } < 0
        {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        self.nodes.insert(token, Node { watch, name });
        Ok(token)
    }
    fn remove_node(&mut self, file: &File, token: u64) {
        self.nodes.remove(&token);
        if let Some(queue) = &self.queue {
            let event = libc::kevent {
                ident: file.as_raw_fd() as libc::uintptr_t,
                filter: libc::EVFILT_VNODE,
                flags: libc::EV_DELETE,
                fflags: 0,
                data: 0,
                udata: ptr::null_mut(),
            };
            unsafe {
                libc::kevent(
                    queue.as_raw_fd(),
                    &event,
                    1,
                    ptr::null_mut(),
                    0,
                    ptr::null(),
                )
            };
        }
    }
    fn close_watch(&mut self, watch: Watch) {
        self.remove_node(&watch.file, watch.token);
        for child in watch.children.values() {
            self.remove_node(&child.file, child.token);
        }
        if self.nodes.is_empty() {
            self.queue = None;
        }
    }
    fn refresh(
        &mut self,
        id: u32,
        watch: &mut Watch,
    ) -> Result<Vec<(&'static str, Option<String>)>> {
        let fresh = scan(&watch.file, watch.maximum_entries)?;
        let mut changes = Vec::new();
        if let Some(previous) = &watch.snapshot {
            for (name, stamp) in previous {
                match fresh.get(name) {
                    None => changes.push(("rename", Some(name.clone()))),
                    Some(next) if next != stamp => changes.push((
                        if next.dev != stamp.dev || next.inode != stamp.inode {
                            "rename"
                        } else {
                            "change"
                        },
                        Some(name.clone()),
                    )),
                    _ => {}
                }
            }
            for name in fresh.keys() {
                if !previous.contains_key(name) {
                    changes.push(("rename", Some(name.clone())));
                }
            }
        }
        let obsolete = watch
            .children
            .iter()
            .filter(|(name, child)| {
                fresh
                    .get(*name)
                    .is_none_or(|s| s.link() || s.dev != child.dev || s.inode != child.inode)
            })
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        for name in obsolete {
            if let Some(child) = watch.children.remove(&name) {
                self.remove_node(&child.file, child.token);
            }
        }
        for (name, stamp) in &fresh {
            if stamp.link() || watch.children.contains_key(name) {
                continue;
            }
            let file = open_relative(&watch.file, std::slice::from_ref(name), libc::O_EVTONLY, 0)
                .map_err(io_error)?;
            let metadata = file.metadata().map_err(io_error)?;
            if metadata.dev() != stamp.dev || metadata.ino() != stamp.inode {
                return Err("resource.stale");
            }
            let token = self.register(&file, id, Some(name.clone()))?;
            watch.children.insert(
                name.clone(),
                Child {
                    file,
                    token,
                    dev: stamp.dev,
                    inode: stamp.inode,
                },
            );
        }
        watch.snapshot = Some(fresh);
        Ok(changes)
    }
    pub fn open(
        &mut self,
        file: File,
        persistent: bool,
        maximum: usize,
        maximum_entries: usize,
        name: Option<String>,
    ) -> Result<Value> {
        if self.entries.len() >= maximum.min(1024) || self.next == u32::MAX {
            return Err("resource.handle_limit");
        }
        self.next += 1;
        let id = self.next;
        let directory = file.metadata().map_err(io_error)?.is_dir();
        let token = self.register(&file, id, None)?;
        let mut watch = Watch {
            file,
            token,
            persistent,
            name,
            maximum_entries,
            snapshot: None,
            children: BTreeMap::new(),
        };
        if directory && let Err(error) = self.refresh(id, &mut watch) {
            self.close_watch(watch);
            return Err(error);
        }
        self.entries.insert(id, watch);
        Ok(json!({"bindingId":format!("watch-{id}")}))
    }
    pub fn close(&mut self, binding: &str) {
        let Some(id) = binding
            .strip_prefix("watch-")
            .and_then(|id| id.parse::<u32>().ok())
        else {
            return;
        };
        if let Some(watch) = self.entries.remove(&id) {
            self.close_watch(watch);
        }
    }
    pub fn referenced(&self) -> bool {
        self.entries.values().any(|watch| watch.persistent)
    }
    pub fn poll(&mut self) -> Result<Value> {
        let Some(queue) = &self.queue else {
            return Ok(json!([]));
        };
        let mut events: [libc::kevent; 64] = unsafe { std::mem::zeroed() };
        let timeout = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        let count = unsafe {
            libc::kevent(
                queue.as_raw_fd(),
                ptr::null(),
                0,
                events.as_mut_ptr(),
                events.len() as i32,
                &timeout,
            )
        };
        if count < 0 {
            let error = std::io::Error::last_os_error();
            return if error.kind() == std::io::ErrorKind::Interrupted {
                Ok(json!([]))
            } else {
                Err(io_error(error))
            };
        }
        let mut output = Vec::new();
        let mut emitted = HashSet::new();
        for event in events.iter().take(count as usize) {
            let token = event.udata as usize as u64;
            let Some(node) = self.nodes.get(&token) else {
                continue;
            };
            let id = node.watch;
            let name = node.name.clone();
            let Some(mut watch) = self.entries.remove(&id) else {
                continue;
            };
            let binding = format!("watch-{id}");
            let own_terminal = name.is_none()
                && (event.flags & libc::EV_ERROR != 0
                    || event.fflags & (libc::NOTE_DELETE | libc::NOTE_REVOKE | libc::NOTE_RENAME)
                        != 0);
            let outcome = if own_terminal {
                Err("resource.not_found")
            } else if watch.snapshot.is_some() {
                self.refresh(id, &mut watch).map(|mut changes| {
                    if let Some(name) = name
                        && changes.is_empty()
                    {
                        changes.push(("change", Some(name)));
                    }
                    changes
                })
            } else {
                Ok(vec![("change", watch.name.clone())])
            };
            match outcome {
                Err(code) => {
                    let code = match code {
                        "resource.not_found" => "ENOENT",
                        "provider.quota" | "resource.handle_limit" => "ENOSPC",
                        _ => "EIO",
                    };
                    output.push(json!({"bindingId":binding,"event":{"event":"error","tuple":[{"code":code}]}}));
                    output.push(json!({"bindingId":binding,"event":{"event":"close","tuple":[]}}));
                    self.close_watch(watch);
                }
                Ok(changes) => {
                    for (kind, name) in changes {
                        if emitted.insert((id, kind, name.clone())) {
                            output.push(json!({"bindingId":binding,"event":{"event":"change","tuple":[kind,name]}}));
                        }
                    }
                    self.entries.insert(id, watch);
                }
            }
        }
        Ok(Value::Array(output))
    }
}
