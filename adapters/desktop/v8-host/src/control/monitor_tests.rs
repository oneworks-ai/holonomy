use super::*;

#[test]
fn cooperative_ack_prevents_failure_and_ids_are_never_reused() {
    let monitor = HostMonitor::default();
    let ticket = monitor.register(1, Duration::ZERO).unwrap();
    assert!(ticket.cancelled());
    assert!(monitor.register(1, Duration::from_secs(1)).is_none());
    ticket.completed.store(true, Ordering::Release);
    assert!(!monitor.poll_failure());
    assert!(monitor.register(2, Duration::from_secs(1)).is_some());
}

#[test]
fn missed_cancellation_ack_fails_generation_without_an_unbounded_wait() {
    let monitor = HostMonitor::default();
    let ticket = Arc::new(GateTicket {
        id: 1,
        deadline: Instant::now() - GATE_CANCEL_GRACE - Duration::from_millis(1),
        cancelled: AtomicBool::new(false),
        completed: AtomicBool::new(false),
    });
    monitor.gates.lock().unwrap().active.push(ticket.clone());
    assert!(monitor.poll_failure());
    assert!(ticket.cancelled.load(Ordering::Acquire));
    assert!(monitor.register(2, Duration::from_secs(1)).is_none());
}
