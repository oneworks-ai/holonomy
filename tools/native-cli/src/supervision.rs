//! CLI-owned Unix supervision; signal handlers never call V8, allocate or lock.
use std::{
    io::{ErrorKind, Write},
    os::{
        fd::AsRawFd,
        unix::process::{CommandExt, ExitStatusExt},
    },
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicI32, AtomicU32, Ordering},
    time::{Duration, Instant},
};

static SIGNAL: AtomicI32 = AtomicI32::new(0);
static SIGNAL_COUNT: AtomicU32 = AtomicU32::new(0);
const GRACE: Duration = Duration::from_secs(1);
const REAP_GRACE: Duration = Duration::from_millis(500);
const LAUNCH_FAILURE_GRACE: Duration = Duration::from_millis(100);

extern "C" fn record_signal(signal: libc::c_int) {
    let _ = SIGNAL.compare_exchange(0, signal, Ordering::Relaxed, Ordering::Relaxed);
    SIGNAL_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub(crate) struct Signals(Vec<(libc::c_int, libc::sigaction)>);
impl Signals {
    pub(crate) fn install() -> Result<Self, String> {
        SIGNAL.store(0, Ordering::Relaxed);
        SIGNAL_COUNT.store(0, Ordering::Relaxed);
        let mut installed = Self(Vec::new());
        for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = record_signal as *const () as usize;
            unsafe { libc::sigemptyset(&mut action.sa_mask) };
            let mut old = std::mem::MaybeUninit::uninit();
            if unsafe { libc::sigaction(signal, &action, old.as_mut_ptr()) } != 0 {
                return Err("Cannot install CLI signal handling".into());
            }
            installed.0.push((signal, unsafe { old.assume_init() }));
        }
        Ok(installed)
    }
}
impl Drop for Signals {
    fn drop(&mut self) {
        for (signal, action) in self.0.iter().rev() {
            unsafe { libc::sigaction(*signal, action, std::ptr::null_mut()) };
        }
    }
}

struct OwnedRuntime {
    child: Child,
    control: Option<ChildStdin>,
    reaped: bool,
}
impl OwnedRuntime {
    fn kill_group(&mut self) {
        // spawn's process_group(0) guarantees this ID names only our child group.
        if let Ok(group) = i32::try_from(self.child.id()) {
            unsafe { libc::kill(-group, libc::SIGKILL) };
        }
        let _ = self.child.kill();
    }
    fn poll(&mut self) -> Result<Option<ExitStatus>, String> {
        let result = self
            .child
            .try_wait()
            .map_err(|_| "Cannot collect Runtime exit")?;
        if result.is_some() {
            self.reaped = true;
        }
        Ok(result)
    }
}
impl Drop for OwnedRuntime {
    fn drop(&mut self) {
        self.control.take();
        if self.reaped {
            return;
        }
        self.kill_group();
        let deadline = Instant::now() + REAP_GRACE;
        while Instant::now() < deadline {
            if self.poll().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        // An uninterruptible kernel wait must not indefinitely block CLI exit.
    }
}

fn exit_code(status: ExitStatus) -> i32 {
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(1))
}

fn terminal_code(status: ExitStatus) -> i32 {
    // This final observation is the exit decision's linearization point.
    // A signal recorded while try_wait was collecting status must win.
    let signal = SIGNAL.load(Ordering::Relaxed);
    if signal != 0 {
        128 + signal
    } else {
        exit_code(status)
    }
}

fn launch_failure_expired(failed_at: Instant) -> bool {
    // The final signal observation also linearizes the transport-error path.
    // A recorded signal returns control to the ordinary cancellation loop.
    failed_at.elapsed() >= LAUNCH_FAILURE_GRACE && SIGNAL.load(Ordering::Relaxed) == 0
}

pub fn run(launch: &str) -> Result<i32, String> {
    let _signals = Signals::install()?;
    run_owned(launch)
}

pub(crate) fn interrupted_code() -> Option<i32> {
    let signal = SIGNAL.load(Ordering::Relaxed);
    (signal != 0).then_some(128 + signal)
}

pub(crate) fn run_owned(launch: &str) -> Result<i32, String> {
    if SIGNAL.load(Ordering::Relaxed) != 0 {
        return Ok(128 + SIGNAL.load(Ordering::Relaxed));
    }
    let child =
        Command::new(std::env::current_exe().map_err(|_| "Executable path is unavailable")?)
            .arg("__runtime")
            .env_clear()
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|_| "Cannot create Runtime process")?;
    let mut runtime = OwnedRuntime {
        child,
        control: None,
        reaped: false,
    };
    runtime.control = runtime.child.stdin.take();
    let fd = runtime
        .control
        .as_ref()
        .ok_or("Missing Runtime control pipe")?
        .as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err("Cannot configure Runtime control pipe".into());
    }
    supervise(runtime, format!("{launch}\n").as_bytes())
}

fn supervise(mut runtime: OwnedRuntime, bytes: &[u8]) -> Result<i32, String> {
    let mut sent = 0;
    let mut cancelling = None;
    let mut killed_at = None;
    let mut launch_failed: Option<Instant> = None;
    loop {
        let signal = SIGNAL.load(Ordering::Relaxed);
        if let Some(status) = runtime.poll()? {
            return Ok(terminal_code(status));
        }
        if signal != 0 {
            runtime.control.take(); // EOF reuses the existing Runtime cancellation path.
            let started = *cancelling.get_or_insert_with(Instant::now);
            if killed_at.is_none()
                && (started.elapsed() >= GRACE || SIGNAL_COUNT.load(Ordering::Relaxed) > 1)
            {
                runtime.kill_group();
                killed_at = Some(Instant::now());
            }
            if killed_at.is_some_and(|time| time.elapsed() >= REAP_GRACE) {
                return Ok(128 + signal);
            }
        } else if let Some(failed_at) = launch_failed {
            if launch_failure_expired(failed_at) {
                return Err("Cannot send Runtime launch".into());
            }
        } else if sent < bytes.len() {
            let end = bytes.len().min(sent + 65536);
            match runtime
                .control
                .as_mut()
                .ok_or("Runtime control pipe closed")?
                .write(&bytes[sent..end])
            {
                Ok(0) => launch_failed = Some(Instant::now()),
                Ok(count) => sent += count,
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                Err(_) => launch_failed = Some(Instant::now()),
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn terminal_decision_observes_signal_recorded_after_earlier_poll_snapshot() {
        let _guard = LOCK.lock().unwrap();
        SIGNAL.store(0, Ordering::Relaxed);
        assert_eq!(SIGNAL.load(Ordering::Relaxed), 0);
        record_signal(libc::SIGTERM);
        assert_eq!(terminal_code(ExitStatus::from_raw(7 << 8)), 143);
        SIGNAL.store(0, Ordering::Relaxed);
        SIGNAL_COUNT.store(0, Ordering::Relaxed);
    }

    #[test]
    fn batch_observation_does_not_return_a_stale_success_after_signal() {
        let _guard = LOCK.lock().unwrap();
        SIGNAL.store(0, Ordering::Relaxed);
        let collected_child_code = 0;
        record_signal(libc::SIGTERM);
        assert_eq!(interrupted_code().unwrap_or(collected_child_code), 143);
        SIGNAL.store(0, Ordering::Relaxed);
        SIGNAL_COUNT.store(0, Ordering::Relaxed);
    }

    #[test]
    fn closed_launch_pipe_preserves_early_child_exit() {
        let _guard = LOCK.lock().unwrap();
        assert_eq!(early_exit("exec 0<&-; sleep 0.02; exit 7"), 7);
    }

    #[test]
    fn expired_launch_failure_does_not_override_recorded_signal() {
        let _guard = LOCK.lock().unwrap();
        SIGNAL.store(0, Ordering::Relaxed);
        let failed_at = Instant::now() - LAUNCH_FAILURE_GRACE;
        assert!(launch_failure_expired(failed_at));
        record_signal(libc::SIGINT);
        assert!(!launch_failure_expired(failed_at));
        SIGNAL.store(0, Ordering::Relaxed);
        SIGNAL_COUNT.store(0, Ordering::Relaxed);
    }

    #[test]
    fn closed_launch_pipe_preserves_early_child_signal() {
        let _guard = LOCK.lock().unwrap();
        assert_eq!(early_exit("exec 0<&-; sleep 0.02; kill -TERM $$"), 143);
    }

    fn early_exit(script: &str) -> i32 {
        SIGNAL.store(0, Ordering::Relaxed);
        SIGNAL_COUNT.store(0, Ordering::Relaxed);
        // Close input before exiting: supervision must collect status instead
        // of translating EPIPE into a fabricated transport-error exit.
        let mut child = Command::new("/bin/sh")
            .args(["-c", script])
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let control = child.stdin.take().unwrap();
        let fd = control.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        assert!(flags >= 0);
        assert_eq!(
            unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) },
            0
        );
        let runtime = OwnedRuntime {
            child,
            control: Some(control),
            reaped: false,
        };
        supervise(runtime, &vec![b'x'; 1024 * 1024]).unwrap()
    }
}
