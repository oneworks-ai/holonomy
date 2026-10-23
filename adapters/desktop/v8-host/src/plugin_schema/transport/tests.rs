use super::*;

// These cases share process-global Schema/Observer helper quotas. Their
// capacity assertions must not race each other under the lib test harness.
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn test_guard() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner())
}

fn shell(script: &str, input: &[u8]) -> Result<(), &'static str> {
    run(
        Path::new("/bin/sh"),
        &["-c", script],
        input,
        Duration::from_millis(100),
        u64::MAX,
        &AtomicBool::new(false),
    )
}

#[test]
fn helper_protocol_requires_exact_single_accept_byte_and_successful_exit() {
    let _guard = test_guard();
    assert!(shell("printf '\\001'", b"").is_ok());
    for script in [
        "printf '\\000'",
        "printf '\\001extra'",
        "printf '\\001';exit 3",
        "exit 0",
        "kill -KILL $$",
    ] {
        assert!(shell(script, b"").is_err());
    }
}

#[test]
fn blocked_write_and_hung_helper_have_bounded_cleanup_and_reusable_capacity() {
    let _guard = test_guard();
    let started = Instant::now();
    assert!(shell("while :;do :;done", &vec![0; 2 * 1024 * 1024]).is_err());
    assert!(shell("while :;do :;done", b"").is_err());
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(shell("printf '\\001'", b"").is_ok());
}

#[cfg(target_os = "macos")]
#[test]
fn resident_memory_limit_kills_the_helper_without_poisoning_next_call() {
    let _guard = test_guard();
    assert!(
        run(
            Path::new("/bin/sh"),
            &["-c", "while :;do :;done"],
            b"",
            Duration::from_secs(1),
            1,
            &AtomicBool::new(false),
        )
        .is_err()
    );
    assert!(shell("printf '\\001'", b"").is_ok());
}

#[test]
fn cancelled_helper_never_waits_for_the_execution_deadline() {
    let _guard = test_guard();
    let started = Instant::now();
    assert!(
        run(
            Path::new("/bin/sh"),
            &["-c", "while :;do :;done"],
            b"",
            Duration::from_secs(120),
            u64::MAX,
            &AtomicBool::new(true)
        )
        .is_err()
    );
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn declared_schema_deadline_reaps_hung_helper_and_reuses_capacity() {
    let _guard = test_guard();
    assert_eq!(super::super::DEADLINE, Duration::from_millis(750));
    let cancelled = std::sync::Arc::new(AtomicBool::new(false));
    let fallback = cancelled.clone();
    let (done, receive) = std::sync::mpsc::channel();
    let safety = std::thread::spawn(move || {
        if receive.recv_timeout(Duration::from_secs(5)).is_err() {
            fallback.store(true, Ordering::Release);
        }
    });
    let result = run(
        Path::new("/bin/sh"),
        &["-c", "while :;do :;done"],
        b"",
        super::super::DEADLINE,
        u64::MAX,
        &cancelled,
    );
    done.send(()).unwrap();
    safety.join().unwrap();
    assert!(result.is_err());
    assert!(
        !cancelled.load(Ordering::Acquire),
        "transport failed to enforce its own 750 ms deadline"
    );
    let mut slots = Vec::new();
    for _ in 0..4 {
        slots.push(spawn_duplex(Path::new("/bin/cat"), &[], PoolKind::Schema).unwrap());
    }
    assert!(spawn_duplex(Path::new("/bin/cat"), &[], PoolKind::Schema).is_err());
    drop(slots);
}

#[test]
fn schema_deadline_includes_spawn_delay() {
    let _guard = test_guard();
    let cancelled = AtomicBool::new(false);
    // A valid immediate response after a deliberately delayed spawn would be
    // accepted if the deadline were incorrectly started after process launch.
    let result = run_with_spawner(b"", super::super::DEADLINE, u64::MAX, &cancelled, || {
        std::thread::sleep(super::super::DEADLINE + Duration::from_millis(10));
        spawn_duplex(
            Path::new("/bin/sh"),
            &["-c", "printf '\\001'"],
            PoolKind::Schema,
        )
    });
    assert!(result.is_err());
    assert!(!cancelled.load(Ordering::Acquire));
    assert!(shell("printf '\\001'", b"").is_ok());
}

#[test]
fn four_observer_slots_do_not_consume_schema_helper_capacity() {
    let _guard = test_guard();
    let mut observers = Vec::new();
    for _ in 0..4 {
        observers.push(spawn_duplex(Path::new("/bin/cat"), &[], PoolKind::Observer).unwrap());
    }
    assert!(spawn_duplex(Path::new("/bin/cat"), &[], PoolKind::Observer).is_err());
    // Prove the Schema pool remains available while all four diagnostic
    // permits are live. Protocol bytes and timing are covered separately.
    let (schema_socket, mut schema_helper) =
        spawn_duplex(Path::new("/bin/cat"), &[], PoolKind::Schema).unwrap();
    assert!(schema_helper.try_wait().unwrap().is_none());
    drop(schema_socket);
    drop(schema_helper);
    drop(observers);
}
