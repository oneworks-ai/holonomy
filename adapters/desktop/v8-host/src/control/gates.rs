//! Host-only async decisions with a private native waiter, not Guest promises.
use super::{calls, monitor::GateTicket, protocol::ControlFailure};
use std::{
    collections::BTreeMap,
    sync::{Arc, atomic::Ordering, mpsc::SyncSender},
};

struct Pending {
    ticket: Arc<GateTicket>,
    promise: v8::Global<v8::Promise>,
    reply: SyncSender<Result<String, ControlFailure>>,
    cancel_sent: bool,
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.ticket.completed.store(true, Ordering::Release);
    }
}
#[derive(Default)]
pub(super) struct Gates {
    pending: BTreeMap<u64, Pending>,
}
impl Gates {
    pub fn active(&self) -> bool {
        !self.pending.is_empty()
    }
    pub fn accept(
        &mut self,
        scope: &mut v8::PinScope,
        encoded: String,
        source_prefix: Option<zeroize::Zeroizing<Vec<u8>>>,
        ticket: Arc<GateTicket>,
        reply: SyncSender<Result<String, ControlFailure>>,
    ) -> Option<()> {
        if ticket.cancelled() {
            ticket.completed.store(true, Ordering::Release);
            let _ = reply.try_send(Err(ControlFailure::ExecutionFailed));
            return Some(());
        }
        if self.pending.len() >= 32 || self.pending.contains_key(&ticket.id) {
            return None;
        }
        match calls::invoke_gate_promise(
            scope,
            &encoded,
            source_prefix.as_ref().map(|prefix| prefix.as_slice()),
        ) {
            Some(promise) => {
                self.pending.insert(
                    ticket.id,
                    Pending {
                        ticket,
                        promise,
                        reply,
                        cancel_sent: false,
                    },
                );
            }
            None => {
                ticket.completed.store(true, Ordering::Release);
                let _ = reply.try_send(Err(ControlFailure::ExecutionFailed));
            }
        }
        Some(())
    }
    pub fn cancel_expired(&mut self, scope: &mut v8::PinScope) -> Option<()> {
        for pending in self.pending.values_mut() {
            if pending.ticket.cancelled() && !pending.cancel_sent {
                pending.cancel_sent = true;
                calls::invoke_host(scope, "cancelEngineGate", &[pending.ticket.id.to_string()])?;
            }
        }
        Some(())
    }
    pub fn pump(&mut self, scope: &mut v8::PinScope) -> Option<()> {
        self.cancel_expired(scope)?;
        scope.perform_microtask_checkpoint();
        let (context, _) = calls::handles(scope)?;
        let context = v8::Local::new(scope, context);
        let scope = &mut v8::ContextScope::new(scope, context);
        let mut finished = Vec::new();
        for (id, pending) in &self.pending {
            let promise = v8::Local::new(scope, &pending.promise);
            let result = match promise.state() {
                v8::PromiseState::Pending => continue,
                v8::PromiseState::Rejected => Err(ControlFailure::ExecutionFailed),
                v8::PromiseState::Fulfilled => {
                    let value = promise.result(scope);
                    v8::Local::<v8::String>::try_from(value)
                        .ok()
                        .filter(|text| text.utf8_length(scope) <= 16 * 1024)
                        .map(|text| text.to_rust_string_lossy(scope))
                        .ok_or(ControlFailure::InvalidResult)
                }
            };
            let result = if pending.ticket.cancelled() {
                Err(ControlFailure::ExecutionFailed)
            } else {
                result
            };
            // Publish cancellation/terminal acknowledgement before waking the
            // waiter; a descheduled Host must not be mistaken for a stuck Gate.
            pending.ticket.completed.store(true, Ordering::Release);
            let _ = pending.reply.try_send(result);
            finished.push(*id);
        }
        for id in finished {
            self.pending.remove(&id);
        }
        Some(())
    }
}
