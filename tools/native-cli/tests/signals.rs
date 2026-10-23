#![cfg(target_os = "macos")]

use std::{
    fs,
    io::{BufRead, BufReader},
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    directory: PathBuf,
    child: Child,
    runtime: i32,
}
impl Fixture {
    fn start(source: &str) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "holo-signals-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("index.mjs"), source).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_holo"))
            .arg("index.mjs")
            .current_dir(&directory)
            .env_clear()
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line);
            let _ = send.send((result.is_ok(), line));
        });
        let mut fixture = Self {
            directory,
            child,
            runtime: 0,
        };
        let (ok, line) = receive
            .recv_timeout(Duration::from_secs(5))
            .expect("Guest ready marker");
        assert!(ok);
        assert_eq!(line, "READY\n");
        let children = Command::new("/usr/bin/pgrep")
            .args(["-P", &fixture.child.id().to_string()])
            .output()
            .unwrap();
        let children = String::from_utf8(children.stdout)
            .unwrap()
            .lines()
            .map(|line| line.trim().parse::<i32>().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            children.len(),
            1,
            "only the owned Runtime should be a direct child"
        );
        fixture.runtime = children[0];
        assert_eq!(unsafe { libc::getpgid(fixture.runtime) }, fixture.runtime);
        assert_ne!(fixture.runtime, fixture.child.id() as i32);
        fixture
    }
    fn wait(&mut self) -> ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "CLI signal shutdown did not terminate"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn parent_signal(&self, signal: i32) {
        assert_eq!(unsafe { libc::kill(self.child.id() as i32, signal) }, 0);
    }
    fn assert_runtime_gone(&mut self) {
        assert_eq!(
            unsafe { libc::kill(self.runtime, 0) },
            -1,
            "owned Runtime was not reaped"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        self.runtime = 0; // Never signal a numeric PID again after observing it gone.
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.runtime > 0 {
            unsafe { libc::kill(-self.runtime, libc::SIGKILL) };
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn parent_interrupt_cancels_busy_runtime_and_returns_conventional_code() {
    let mut fixture = Fixture::start("console.log('READY');while(true){}");
    fixture.parent_signal(libc::SIGINT);
    assert_eq!(fixture.wait().code(), Some(130));
    fixture.assert_runtime_gone();
}

#[test]
fn terminal_group_signal_is_received_by_cli_not_directly_by_private_runtime() {
    let mut fixture = Fixture::start("console.log('READY');setInterval(()=>{},1000);");
    assert_eq!(
        unsafe { libc::kill(-(fixture.child.id() as i32), libc::SIGTERM) },
        0
    );
    assert_eq!(fixture.wait().code(), Some(143));
    fixture.assert_runtime_gone();
}

#[test]
fn stopped_runtime_is_killed_after_bounded_grace() {
    let mut fixture = Fixture::start("console.log('READY');setInterval(()=>{},1000);");
    assert_eq!(unsafe { libc::kill(fixture.runtime, libc::SIGSTOP) }, 0);
    fixture.parent_signal(libc::SIGHUP);
    assert_eq!(fixture.wait().code(), Some(129));
    fixture.assert_runtime_gone();
}

#[test]
fn runtime_signal_exit_is_reported_without_fabricating_exit_one() {
    let mut fixture = Fixture::start("console.log('READY');setInterval(()=>{},1000);");
    assert_eq!(unsafe { libc::kill(fixture.runtime, libc::SIGTERM) }, 0);
    assert_eq!(fixture.wait().code(), Some(143));
    fixture.assert_runtime_gone();
}

#[test]
fn second_signal_forces_stopped_runtime_without_waiting_for_grace() {
    let mut fixture = Fixture::start("console.log('READY');setInterval(()=>{},1000);");
    assert_eq!(unsafe { libc::kill(fixture.runtime, libc::SIGSTOP) }, 0);
    fixture.parent_signal(libc::SIGINT);
    // Distinct signals avoid standard Unix signal coalescing.
    std::thread::sleep(Duration::from_millis(50));
    let start = Instant::now();
    fixture.parent_signal(libc::SIGTERM);
    assert_eq!(fixture.wait().code(), Some(130));
    assert!(start.elapsed() < Duration::from_millis(800));
    fixture.assert_runtime_gone();
}
