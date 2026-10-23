//! Bounded one-shot helper transport, independent of Runtime scheduling.
use super::FAILED;
use std::{
    io::{ErrorKind, Read, Write},
    net::Shutdown,
    os::{fd::OwnedFd, unix::net::UnixStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

static SCHEMA_CHILDREN: AtomicUsize = AtomicUsize::new(0);
static SCHEMA_REAPING: Mutex<Vec<(Child, Permit)>> = Mutex::new(Vec::new());
static OBSERVER_CHILDREN: AtomicUsize = AtomicUsize::new(0);
static OBSERVER_REAPING: Mutex<Vec<(Child, Permit)>> = Mutex::new(Vec::new());

#[derive(Clone, Copy)]
pub(crate) enum PoolKind {
    Schema,
    Observer,
}
impl PoolKind {
    fn state(self) -> (&'static AtomicUsize, &'static Mutex<Vec<(Child, Permit)>>) {
        match self {
            Self::Schema => (&SCHEMA_CHILDREN, &SCHEMA_REAPING),
            Self::Observer => (&OBSERVER_CHILDREN, &OBSERVER_REAPING),
        }
    }
}

struct Permit(PoolKind);
impl Permit {
    fn acquire(kind: PoolKind) -> Option<Self> {
        let (children, reaping) = kind.state();
        reaping
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain_mut(|(child, _)| child.try_wait().ok().flatten().is_none());
        children
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 4).then_some(n + 1)
            })
            .ok()?;
        Some(Self(kind))
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.state().0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) struct Helper {
    child: Option<Child>,
    permit: Option<Permit>,
}
impl Helper {
    pub(crate) fn id(&self) -> Option<u32> {
        self.child.as_ref().map(Child::id)
    }

    pub(crate) fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.as_mut().expect("owned helper").try_wait()
    }
}
impl Drop for Helper {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        let _ = child.kill();
        let deadline = Instant::now() + Duration::from_millis(100);
        while Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        // Kernel-delayed reaping cannot block live JS. Its permit stays held;
        // the next validation polls this bounded queue, never an unbounded join.
        if let Some(permit) = self.permit.take() {
            permit
                .0
                .state()
                .1
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push((child, permit));
        }
    }
}

pub(super) fn run(
    executable: &Path,
    arguments: &[&str],
    input: &[u8],
    timeout: Duration,
    max_resident_bytes: u64,
    cancelled: &AtomicBool,
) -> Result<(), &'static str> {
    run_with_spawner(input, timeout, max_resident_bytes, cancelled, || {
        spawn_duplex(executable, arguments, PoolKind::Schema)
    })
}

fn run_with_spawner(
    input: &[u8],
    timeout: Duration,
    max_resident_bytes: u64,
    cancelled: &AtomicBool,
    spawn: impl FnOnce() -> Result<(UnixStream, Helper), &'static str>,
) -> Result<(), &'static str> {
    // Reserve the whole validation budget before process creation. A delayed
    // spawn must not give the validator a fresh execution window.
    let deadline = Instant::now().checked_add(timeout).ok_or(FAILED)?;
    let (mut socket, mut helper) = spawn()?;
    let child = helper.child.as_mut().ok_or(FAILED)?;
    let mut sent = 0;
    let mut sealed = false;
    let mut response = Vec::new();
    let mut eof = false;
    loop {
        if Instant::now() >= deadline || cancelled.load(Ordering::Acquire) {
            return Err(FAILED);
        }
        if sent < input.len() {
            match socket.write(&input[sent..input.len().min(sent + 65536)]) {
                Ok(0) => return Err(FAILED),
                Ok(count) => sent += count,
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                Err(_) => return Err(FAILED),
            }
        }
        if sent == input.len() && !sealed {
            socket.shutdown(Shutdown::Write).map_err(|_| FAILED)?;
            sealed = true;
        }
        if !eof {
            let mut bytes = [0_u8; 2];
            match socket.read(&mut bytes) {
                Ok(0) => eof = true,
                Ok(count) => response.extend_from_slice(&bytes[..count]),
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                Err(_) => return Err(FAILED),
            }
            if response.len() > 1 {
                return Err(FAILED);
            }
        }
        if let Some(status) = child.try_wait().map_err(|_| FAILED)? {
            if eof {
                return (sealed && status.success() && response == [1])
                    .then_some(())
                    .ok_or(FAILED);
            }
        } else if resident_bytes(child.id()).is_some_and(|bytes| bytes > max_resident_bytes) {
            return Err(FAILED);
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// The same owned, quota-counted, bounded-reap launcher serves both disposable
/// schema validators and long-lived diagnostic observer helpers.
pub(crate) fn spawn_duplex(
    executable: &Path,
    arguments: &[&str],
    pool: PoolKind,
) -> Result<(UnixStream, Helper), &'static str> {
    let permit = Permit::acquire(pool).ok_or(FAILED)?;
    let (socket, peer) = UnixStream::pair().map_err(|_| FAILED)?;
    socket.set_nonblocking(true).map_err(|_| FAILED)?;
    let child = Command::new(executable)
        .args(arguments)
        .env_clear()
        .current_dir("/")
        .stdin(Stdio::from(OwnedFd::from(
            peer.try_clone().map_err(|_| FAILED)?,
        )))
        .stdout(Stdio::from(OwnedFd::from(peer)))
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| FAILED)?;
    Ok((
        socket,
        Helper {
            child: Some(child),
            permit: Some(permit),
        },
    ))
}

#[cfg(target_os = "macos")]
pub(crate) fn resident_bytes(pid: u32) -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v0>::uninit();
    let result = unsafe {
        libc::proc_pid_rusage(
            pid.try_into().ok()?,
            libc::RUSAGE_INFO_V0,
            usage.as_mut_ptr().cast(),
        )
    };
    (result == 0).then(|| unsafe { usage.assume_init().ri_resident_size })
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn resident_bytes(_pid: u32) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests;
