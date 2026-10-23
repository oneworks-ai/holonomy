//! Native, engine-independent v86 I/O port. Only a trusted Host installation
//! supplies artifact paths; Process authority and supervisor frames stay in JS.
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::{File, OpenOptions},
    io::Read,
    path::Path,
};

pub const MAX_ENVIRONMENTS: usize = 4;
pub const MAX_SERIAL_QUEUE_BYTES: usize = 256 * 1024;
pub const MAX_SERIAL_WRITE_BYTES: usize = 64 * 1024;
pub const MAX_ARTIFACT_BYTES: u64 = 128 * 1024 * 1024;
pub const MIN_MEMORY_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_MEMORY_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_TOTAL_MEMORY_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_TOTAL_ARTIFACT_BYTES: u64 = 192 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VmError {
    Invalid,
    Unavailable,
    Limit,
    Generation,
    Artifact,
    Engine,
}

#[derive(Clone, Debug)]
pub struct ArtifactSpec {
    pub name: &'static str,
    pub sha256: String,
    pub size: u64,
}

/// Immutable bytes read through nofollow descriptors before Guest entry.
pub struct VerifiedArtifacts {
    bios: Vec<u8>,
    kernel: Vec<u8>,
    initrd: Vec<u8>,
}

impl VerifiedArtifacts {
    pub fn bios(&self) -> &[u8] {
        &self.bios
    }
    pub fn kernel(&self) -> &[u8] {
        &self.kernel
    }
    pub fn initrd(&self) -> &[u8] {
        &self.initrd
    }
    /// `root` and specs come from the owner-private installation, never Guest JSON.
    pub fn install(root: &Path, specs: &[ArtifactSpec; 3]) -> Result<Self, VmError> {
        #[cfg(unix)]
        use std::os::unix::{
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawFd,
        };
        let mut root_options = OpenOptions::new();
        root_options.read(true);
        #[cfg(unix)]
        root_options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
        let directory = root_options.open(root).map_err(|_| VmError::Artifact)?;
        let metadata = directory.metadata().map_err(|_| VmError::Artifact)?;
        if !metadata.is_dir() || root.canonicalize().map_err(|_| VmError::Artifact)? != root {
            return Err(VmError::Artifact);
        }
        #[cfg(unix)]
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
            return Err(VmError::Artifact);
        }
        let read = |spec: &ArtifactSpec| -> Result<Vec<u8>, VmError> {
            if !matches!(spec.name, "seabios.bin" | "kernel.bin" | "agent.cpio")
                || spec.size == 0
                || spec.size > MAX_ARTIFACT_BYTES
                || spec.sha256.len() != 64
                || !spec.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(VmError::Artifact);
            }
            #[cfg(unix)]
            let file = {
                let name = std::ffi::CString::new(spec.name).map_err(|_| VmError::Artifact)?;
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                    )
                };
                if fd < 0 {
                    return Err(VmError::Artifact);
                }
                use std::os::fd::FromRawFd;
                unsafe { File::from_raw_fd(fd) }
            };
            #[cfg(not(unix))]
            let file = File::open(root.join(spec.name)).map_err(|_| VmError::Artifact)?;
            let meta = file.metadata().map_err(|_| VmError::Artifact)?;
            if !meta.is_file() || meta.len() != spec.size {
                return Err(VmError::Artifact);
            }
            #[cfg(unix)]
            if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 {
                return Err(VmError::Artifact);
            }
            let mut bytes = Vec::with_capacity(spec.size as usize);
            file.take(spec.size + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| VmError::Artifact)?;
            if bytes.len() as u64 != spec.size
                || format!("{:x}", Sha256::digest(&bytes)) != spec.sha256.to_ascii_lowercase()
            {
                return Err(VmError::Artifact);
            }
            Ok(bytes)
        };
        if specs[0].name != "seabios.bin"
            || specs[1].name != "kernel.bin"
            || specs[2].name != "agent.cpio"
            || specs
                .iter()
                .try_fold(0u64, |total, spec| total.checked_add(spec.size))
                .is_none_or(|total| total > MAX_TOTAL_ARTIFACT_BYTES)
        {
            return Err(VmError::Artifact);
        }
        Ok(Self {
            bios: read(&specs[0])?,
            kernel: read(&specs[1])?,
            initrd: read(&specs[2])?,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VmStatus {
    Open,
    Running,
    Stopped,
    Failed,
}

pub struct SerialChunk {
    pub uart: u8,
    pub bytes: Vec<u8>,
}
pub struct EnginePoll {
    pub status: VmStatus,
    pub chunks: Vec<SerialChunk>,
}

/// Implementations own the VM/Wasm lifecycle. No engine thread may call Guest V8.
pub trait VmEngine {
    type Handle;
    fn open(
        &mut self,
        memory_bytes: u64,
        artifacts: &VerifiedArtifacts,
    ) -> Result<Self::Handle, VmError>;
    fn open_with_network(
        &mut self,
        memory_bytes: u64,
        artifacts: &VerifiedArtifacts,
        enabled: bool,
    ) -> Result<Self::Handle, VmError> {
        if enabled {
            Err(VmError::Unavailable)
        } else {
            self.open(memory_bytes, artifacts)
        }
    }
    fn start(&mut self, handle: &mut Self::Handle) -> Result<(), VmError>;
    fn serial_write(&mut self, handle: &mut Self::Handle, bytes: &[u8]) -> Result<(), VmError>;
    fn network_drain(
        &mut self,
        _handle: &mut Self::Handle,
        _limit: usize,
    ) -> Result<String, VmError> {
        Err(VmError::Unavailable)
    }
    fn network_deliver(&mut self, _handle: &mut Self::Handle, _input: &str) -> Result<(), VmError> {
        Err(VmError::Unavailable)
    }
    fn poll(&mut self, handle: &mut Self::Handle, max_bytes: usize) -> Result<EnginePoll, VmError>;
    fn close(&mut self, handle: Self::Handle);
}

struct Environment<H> {
    generation: u64,
    memory_bytes: u64,
    handle: H,
    status: VmStatus,
    serial: VecDeque<u8>,
}

/// Host-only VM driver. Environment/process identities and Policy live above it.
pub struct NativeVmPort<E: VmEngine> {
    engine: E,
    environments: HashMap<String, Environment<E::Handle>>,
}

impl<E: VmEngine> NativeVmPort<E> {
    pub fn new(engine: E) -> Self {
        Self {
            engine,
            environments: HashMap::new(),
        }
    }

    pub fn open(
        &mut self,
        id: &str,
        generation: u64,
        memory_bytes: u64,
        artifacts: &VerifiedArtifacts,
    ) -> Result<(), VmError> {
        self.open_with_network(id, generation, memory_bytes, artifacts, false)
    }

    pub fn open_with_network(
        &mut self,
        id: &str,
        generation: u64,
        memory_bytes: u64,
        artifacts: &VerifiedArtifacts,
        network_enabled: bool,
    ) -> Result<(), VmError> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || generation == 0
            || !(MIN_MEMORY_BYTES..=MAX_MEMORY_BYTES).contains(&memory_bytes)
            || self.environments.contains_key(id)
        {
            return Err(VmError::Invalid);
        }
        if self.environments.len() >= MAX_ENVIRONMENTS {
            return Err(VmError::Limit);
        }
        if self
            .environments
            .values()
            .map(|env| env.memory_bytes)
            .sum::<u64>()
            + memory_bytes
            > MAX_TOTAL_MEMORY_BYTES
        {
            return Err(VmError::Limit);
        }
        let handle = self
            .engine
            .open_with_network(memory_bytes, artifacts, network_enabled)?;
        self.environments.insert(
            id.to_owned(),
            Environment {
                generation,
                memory_bytes,
                handle,
                status: VmStatus::Open,
                serial: VecDeque::new(),
            },
        );
        Ok(())
    }

    fn selected<'a>(
        environments: &'a mut HashMap<String, Environment<E::Handle>>,
        id: &str,
        generation: u64,
    ) -> Result<&'a mut Environment<E::Handle>, VmError> {
        let env = environments.get_mut(id).ok_or(VmError::Unavailable)?;
        if env.generation != generation {
            return Err(VmError::Generation);
        }
        Ok(env)
    }

    pub fn start(&mut self, id: &str, generation: u64) -> Result<(), VmError> {
        let env = Self::selected(&mut self.environments, id, generation)?;
        if env.status != VmStatus::Open {
            return Err(VmError::Invalid);
        }
        self.engine.start(&mut env.handle)?;
        env.status = VmStatus::Running;
        Ok(())
    }

    pub fn serial_write(
        &mut self,
        id: &str,
        generation: u64,
        uart: u8,
        bytes: &[u8],
    ) -> Result<(), VmError> {
        if uart != 1 || bytes.len() > MAX_SERIAL_WRITE_BYTES {
            return Err(VmError::Limit);
        }
        let env = Self::selected(&mut self.environments, id, generation)?;
        if env.status != VmStatus::Running {
            return Err(VmError::Invalid);
        }
        self.engine.serial_write(&mut env.handle, bytes)
    }

    pub fn network_drain(
        &mut self,
        id: &str,
        generation: u64,
        limit: usize,
    ) -> Result<String, VmError> {
        if limit == 0 || limit > 4 {
            return Err(VmError::Limit);
        }
        let env = Self::selected(&mut self.environments, id, generation)?;
        if env.status != VmStatus::Running {
            return Err(VmError::Invalid);
        }
        self.engine.network_drain(&mut env.handle, limit)
    }

    pub fn network_deliver(
        &mut self,
        id: &str,
        generation: u64,
        input: &str,
    ) -> Result<(), VmError> {
        if input.len() > MAX_SERIAL_WRITE_BYTES * 2 {
            return Err(VmError::Limit);
        }
        let env = Self::selected(&mut self.environments, id, generation)?;
        if env.status != VmStatus::Running {
            return Err(VmError::Invalid);
        }
        self.engine.network_deliver(&mut env.handle, input)
    }

    pub fn poll(&mut self, id: &str, generation: u64) -> Result<VmStatus, VmError> {
        let env = Self::selected(&mut self.environments, id, generation)?;
        if env.status != VmStatus::Running {
            return Ok(env.status);
        }
        let polled = self
            .engine
            .poll(&mut env.handle, MAX_SERIAL_QUEUE_BYTES - env.serial.len())?;
        for chunk in polled.chunks {
            if chunk.uart != 1 || chunk.bytes.len() > MAX_SERIAL_QUEUE_BYTES - env.serial.len() {
                env.status = VmStatus::Failed;
                env.serial.clear();
                return Err(VmError::Limit);
            }
            env.serial.extend(chunk.bytes);
        }
        env.status = polled.status;
        Ok(env.status)
    }

    pub fn drain_serial(
        &mut self,
        id: &str,
        generation: u64,
        max_bytes: usize,
    ) -> Result<Vec<u8>, VmError> {
        if max_bytes == 0 || max_bytes > MAX_SERIAL_WRITE_BYTES {
            return Err(VmError::Limit);
        }
        let env = Self::selected(&mut self.environments, id, generation)?;
        Ok(env
            .serial
            .drain(..max_bytes.min(env.serial.len()))
            .collect())
    }

    /// Host-only queue size for bounded event notification. It does not expose
    /// serial contents or an engine handle to the Guest.
    pub fn queued_serial_bytes(&self, id: &str, generation: u64) -> Result<usize, VmError> {
        let env = self.environments.get(id).ok_or(VmError::Unavailable)?;
        if env.generation != generation {
            return Err(VmError::Generation);
        }
        Ok(env.serial.len())
    }

    pub fn close(&mut self, id: &str, generation: u64) -> Result<(), VmError> {
        if self
            .environments
            .get(id)
            .ok_or(VmError::Unavailable)?
            .generation
            != generation
        {
            return Err(VmError::Generation);
        }
        let env = self.environments.remove(id).ok_or(VmError::Unavailable)?;
        self.engine.close(env.handle);
        Ok(())
    }

    pub fn close_generation(&mut self, generation: u64) {
        let ids: Vec<_> = self
            .environments
            .iter()
            .filter(|(_, env)| env.generation == generation)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(env) = self.environments.remove(&id) {
                self.engine.close(env.handle);
            }
        }
    }
}

impl<E: VmEngine> Drop for NativeVmPort<E> {
    fn drop(&mut self) {
        for (_, env) in self.environments.drain() {
            self.engine.close(env.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    struct Engine {
        closed: Rc<RefCell<usize>>,
        next: Vec<SerialChunk>,
    }
    impl VmEngine for Engine {
        type Handle = ();
        fn open(&mut self, _: u64, _: &VerifiedArtifacts) -> Result<(), VmError> {
            Ok(())
        }
        fn start(&mut self, _: &mut ()) -> Result<(), VmError> {
            Ok(())
        }
        fn serial_write(&mut self, _: &mut (), _: &[u8]) -> Result<(), VmError> {
            Ok(())
        }
        fn poll(&mut self, _: &mut (), _: usize) -> Result<EnginePoll, VmError> {
            Ok(EnginePoll {
                status: VmStatus::Running,
                chunks: std::mem::take(&mut self.next),
            })
        }
        fn close(&mut self, _: ()) {
            *self.closed.borrow_mut() += 1;
        }
    }
    fn artifacts() -> VerifiedArtifacts {
        VerifiedArtifacts {
            bios: vec![1],
            kernel: vec![2],
            initrd: vec![3],
        }
    }

    #[test]
    fn generation_fences_serial_and_close() {
        let closed = Rc::new(RefCell::new(0));
        let mut port = NativeVmPort::new(Engine {
            closed: closed.clone(),
            next: vec![SerialChunk {
                uart: 1,
                bytes: b"ready".to_vec(),
            }],
        });
        port.open("env", 7, MIN_MEMORY_BYTES, &artifacts()).unwrap();
        assert_eq!(port.start("env", 8), Err(VmError::Generation));
        port.start("env", 7).unwrap();
        assert_eq!(
            port.serial_write("env", 8, 1, b"x"),
            Err(VmError::Generation)
        );
        assert_eq!(port.poll("env", 7), Ok(VmStatus::Running));
        assert_eq!(port.drain_serial("env", 7, 3).unwrap(), b"rea");
        assert_eq!(port.close("env", 8), Err(VmError::Generation));
        port.close_generation(7);
        assert_eq!(*closed.borrow(), 1);
        assert_eq!(port.drain_serial("env", 7, 8), Err(VmError::Unavailable));
    }

    #[test]
    fn overflow_is_terminal_and_bounded() {
        let closed = Rc::new(RefCell::new(0));
        let mut port = NativeVmPort::new(Engine {
            closed: closed.clone(),
            next: vec![SerialChunk {
                uart: 1,
                bytes: vec![3; MAX_SERIAL_QUEUE_BYTES + 1],
            }],
        });
        port.open("env", 1, MIN_MEMORY_BYTES, &artifacts()).unwrap();
        port.start("env", 1).unwrap();
        assert_eq!(port.poll("env", 1), Err(VmError::Limit));
        assert_eq!(port.drain_serial("env", 1, 64).unwrap().len(), 0);
        assert_eq!(port.serial_write("env", 1, 1, b"x"), Err(VmError::Invalid));
        drop(port);
        assert_eq!(*closed.borrow(), 1);
    }

    #[test]
    fn installation_rejects_tamper_and_symlink() {
        let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "holo-v86-port-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        let names = ["seabios.bin", "kernel.bin", "agent.cpio"];
        for name in names {
            std::fs::write(path.join(name), name.as_bytes()).unwrap();
        }
        let specs = names.map(|name| ArtifactSpec {
            name,
            size: name.len() as u64,
            sha256: format!("{:x}", Sha256::digest(name.as_bytes())),
        });
        assert!(VerifiedArtifacts::install(&path, &specs).is_ok());
        std::fs::write(path.join("kernel.bin"), b"tampered!!").unwrap();
        assert!(matches!(
            VerifiedArtifacts::install(&path, &specs),
            Err(VmError::Artifact)
        ));
        std::fs::write(path.join("kernel.bin"), b"kernel.bin").unwrap();
        #[cfg(unix)]
        {
            std::fs::remove_file(path.join("kernel.bin")).unwrap();
            std::os::unix::fs::symlink(path.join("seabios.bin"), path.join("kernel.bin")).unwrap();
            assert!(matches!(
                VerifiedArtifacts::install(&path, &specs),
                Err(VmError::Artifact)
            ));
        }
        std::fs::remove_dir_all(path).unwrap();
    }
}
