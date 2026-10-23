//! A polled Guest import decision using the existing Host Gate ticket/registry.
use super::{monitor::GateTicket, protocol::ControlFailure, transport::Shared};
use std::sync::{
    Arc,
    atomic::Ordering,
    mpsc::{Receiver, TryRecvError},
};

pub(crate) struct ModuleGateDecision {
    pub(super) response: Receiver<Result<String, ControlFailure>>,
    pub(super) ticket: Arc<GateTicket>,
    pub(super) shared: Arc<Shared>,
    pub(super) timeout_ms: u64,
    pub(super) settled: bool,
}

impl ModuleGateDecision {
    pub(crate) fn poll(&mut self) -> Option<bool> {
        if self.settled {
            return Some(false);
        }
        if self.ticket.cancelled()
            || self.shared.stopped()
            || self.shared.monitor.failed.load(Ordering::Acquire)
        {
            self.ticket.cancelled.store(true, Ordering::Release);
            self.settled = true;
            return Some(false);
        }
        let result = match self.response.try_recv() {
            Ok(result) => result,
            Err(TryRecvError::Empty) => return None,
            Err(TryRecvError::Disconnected) => Err(ControlFailure::ExecutionFailed),
        };
        self.settled = true;
        let allowed = result
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .is_some_and(|value| {
                value["decisionTimeoutMs"].as_u64() == Some(self.timeout_ms)
                    && value["decision"].as_object().is_some_and(|decision| {
                        decision.len() == 1
                            && decision.get("action").and_then(|v| v.as_str()) == Some("allow")
                    })
            });
        Some(allowed && !self.ticket.cancelled() && !self.shared.stopped())
    }
}
impl Drop for ModuleGateDecision {
    fn drop(&mut self) {
        if !self.settled {
            self.ticket.cancelled.store(true, Ordering::Release);
        }
    }
}
