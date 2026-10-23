use super::*;

#[test]
fn noncooperative_native_work_fails_shutdown_without_an_unbounded_join() {
    let (release, blocked) = mpsc::sync_channel(1);
    let (finished, observed) = mpsc::sync_channel(1);
    let thread = std::thread::spawn(move || {
        let _ = blocked.recv();
        let _ = finished.send(());
    });
    let (commands, _requests) = mpsc::sync_channel(1);
    let (observers, _events) = mpsc::sync_channel(1);
    let (_results, completions) = mpsc::sync_channel(1);
    let shared = Arc::new(Shared {
        stop: AtomicBool::new(false),
        active: AtomicBool::new(true),
        busy: AtomicBool::new(false),
        cancelled: Arc::new(AtomicBool::new(false)),
        monitor: Arc::new(super::super::monitor::HostMonitor::default()),
        queued_bytes: Arc::new(AtomicUsize::new(0)),
        observer_dropped: AtomicUsize::new(0),
    });
    let mut remote = RemoteControl {
        guest: GuestDelivery::default(),
        shared,
        commands,
        observers,
        completions,
        thread: Some(thread),
        shutdown_result: None,
        gate_limits: GateLimits::default(),
    };
    let start = Instant::now();
    assert_eq!(remote.idle_delay(), Duration::from_millis(20));
    remote.shared.busy.store(true, Ordering::Release);
    assert_eq!(remote.idle_delay(), Duration::from_millis(1));
    assert!(!remote.shutdown_with_limit(Duration::from_millis(10)));
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(remote.shared.monitor.failed.load(Ordering::Acquire));
    assert!(remote.shared.stopped());
    assert!(!remote.shutdown());
    release.send(()).unwrap();
    observed.recv_timeout(Duration::from_secs(1)).unwrap();
}

#[test]
fn cooperative_gate_timeout_discards_late_reply_without_failing_generation() {
    let (commands, requests) = mpsc::sync_channel::<Envelope>(1);
    let (observers, _events) = mpsc::sync_channel(1);
    let (release, blocked) = mpsc::sync_channel(1);
    let (result, observed) = mpsc::sync_channel(1);
    let thread = std::thread::spawn(move || {
        let request = requests.recv().unwrap();
        let Command::Gate { reply, ticket, .. } = request.command else {
            panic!("expected synchronous Gate request")
        };
        blocked.recv().unwrap();
        ticket.completed.store(true, Ordering::Release);
        result
            .send(reply.try_send(Ok("late allow".into())).is_err())
            .unwrap();
    });
    let (_completed, completions) = mpsc::sync_channel(1);
    let shared = Arc::new(Shared {
        stop: AtomicBool::new(false),
        active: AtomicBool::new(true),
        busy: AtomicBool::new(true),
        cancelled: Arc::new(AtomicBool::new(false)),
        monitor: Arc::new(super::super::monitor::HostMonitor::default()),
        queued_bytes: Arc::new(AtomicUsize::new(0)),
        observer_dropped: AtomicUsize::new(0),
    });
    let mut remote = RemoteControl {
        guest: GuestDelivery::default(),
        shared,
        commands,
        observers,
        completions,
        thread: Some(thread),
        shutdown_result: None,
        gate_limits: GateLimits {
            schema_version: 1,
            strings_timeout_ms: Some(10),
            wasm_timeout_ms: None,
            dynamic_import_timeout_ms: None,
            source_reader_max_bytes: 0,
            request_body_reader_max_bytes: 0,
            observer_events: Vec::new(),
        },
    };
    let start = Instant::now();
    assert!(remote.gate(1, "{}".into()).is_err());
    assert!(start.elapsed() < Duration::from_millis(200));
    assert!(!remote.failed());
    release.send(()).unwrap();
    assert!(observed.recv_timeout(Duration::from_secs(1)).unwrap());
    assert!(remote.shutdown());
}

#[test]
fn observer_queue_pressure_preserves_command_capacity_and_fences_late_events() {
    let (commands, requests) = mpsc::sync_channel(1);
    let (observers, events) = mpsc::sync_channel(1);
    let (_completed, completions) = mpsc::sync_channel(1);
    let shared = Arc::new(Shared {
        stop: AtomicBool::new(false),
        active: AtomicBool::new(true),
        busy: AtomicBool::new(false),
        cancelled: Arc::new(AtomicBool::new(false)),
        monitor: Arc::new(super::super::monitor::HostMonitor::default()),
        queued_bytes: Arc::new(AtomicUsize::new(0)),
        observer_dropped: AtomicUsize::new(0),
    });
    let remote = RemoteControl {
        guest: GuestDelivery::default(),
        shared: Arc::clone(&shared),
        commands,
        observers,
        completions,
        thread: None,
        shutdown_result: None,
        gate_limits: GateLimits {
            schema_version: 1,
            strings_timeout_ms: None,
            wasm_timeout_ms: None,
            dynamic_import_timeout_ms: None,
            source_reader_max_bytes: 0,
            request_body_reader_max_bytes: 0,
            observer_events: vec!["script.compiled".into()],
        },
    };
    remote.publish_observer("script.compiled", "first".into());
    remote.publish_observer("script.compiled", "dropped".into());
    assert_eq!(shared.observer_dropped.load(Ordering::Acquire), 1);
    let (reply, _response) = mpsc::sync_channel(1);
    assert!(remote.enqueue(
        Command::Sync {
            method: SyncMethod::Configuration,
            arguments: Vec::new(),
            reply,
        },
        0,
    ));
    assert!(matches!(
        requests.try_recv().unwrap().command,
        Command::Sync { .. }
    ));
    shared.terminate();
    remote.publish_observer("script.compiled", "late".into());
    assert_eq!(events.try_recv().unwrap(), "first");
    assert!(events.try_recv().is_err());
}
