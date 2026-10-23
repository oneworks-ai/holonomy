use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
#[cfg(test)]
#[path = "monitor_tests.rs"]
mod tests;

pub(super) const GATE_CANCEL_GRACE: Duration = Duration::from_millis(100);
pub(super) struct GateTicket {
    pub id: u64,
    pub deadline: Instant,
    pub cancelled: AtomicBool,
    pub completed: AtomicBool,
}
impl GateTicket {
    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire) || Instant::now() >= self.deadline
    }
}
#[derive(Default)]
struct Gates {
    last_id: u64,
    active: Vec<Arc<GateTicket>>,
}

/// The existing native watchdog drives this; it is not another JS runtime.
#[derive(Default)]
pub(crate) struct HostMonitor {
    pub(super) handle: Mutex<Option<v8::IsolateHandle>>,
    pub(super) failed: AtomicBool,
    gates: Mutex<Gates>,
}
impl HostMonitor {
    pub fn interrupt(&self) {
        if let Ok(handle) = self.handle.lock()
            && let Some(handle) = handle.as_ref()
        {
            handle.terminate_execution();
        }
    }
    pub fn poll_failure(&self) -> bool {
        if let Ok(mut gates) = self.gates.lock() {
            gates
                .active
                .retain(|ticket| !ticket.completed.load(Ordering::Acquire));
            let now = Instant::now();
            for ticket in &gates.active {
                if now >= ticket.deadline {
                    ticket.cancelled.store(true, Ordering::Release);
                }
                if now >= ticket.deadline + GATE_CANCEL_GRACE {
                    self.failed.store(true, Ordering::Release);
                }
            }
        } else {
            self.failed.store(true, Ordering::Release);
        }
        self.failed.load(Ordering::Acquire)
    }
    pub(super) fn register(&self, id: u64, timeout: Duration) -> Option<Arc<GateTicket>> {
        let mut gates = self.gates.lock().ok()?;
        gates
            .active
            .retain(|ticket| !ticket.completed.load(Ordering::Acquire));
        if id <= gates.last_id || gates.active.len() >= 32 || self.failed.load(Ordering::Acquire) {
            return None;
        }
        let ticket = Arc::new(GateTicket {
            id,
            deadline: Instant::now().checked_add(timeout)?,
            cancelled: AtomicBool::new(false),
            completed: AtomicBool::new(false),
        });
        gates.last_id = id;
        gates.active.push(ticket.clone());
        Some(ticket)
    }
}
