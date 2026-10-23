//! Owned transfer values. No V8 handle or Host exception belongs in a completion.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub(super) const MAX_PENDING: usize = 256;
pub(super) const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CallId {
    pub generation: u64,
    pub sequence: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(super) enum ControlFailure {
    ExecutionFailed,
    InvalidResult,
    ResultLimit,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Completion {
    pub id: CallId,
    pub result: Result<ControlValue, ControlFailure>,
}

#[derive(Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(super) enum ControlValue {
    Text(String),
    Undefined,
}

pub(super) struct CallLedger<T> {
    generation: u64,
    last_id: u64,
    closed: bool,
    cleanup_id: Option<CallId>,
    entries: HashMap<CallId, T>,
}

impl<T> CallLedger<T> {
    pub fn new(generation: u64) -> Self {
        assert!(generation > 0);
        Self {
            generation,
            last_id: 0,
            closed: false,
            cleanup_id: None,
            entries: HashMap::new(),
        }
    }
    pub fn next_id(&self) -> Option<CallId> {
        self.next(false)
    }
    pub fn next_cleanup_id(&self) -> Option<CallId> {
        self.next(true)
    }
    fn has_capacity(&self, cleanup: bool) -> bool {
        !self.closed
            && if cleanup {
                self.cleanup_id.is_none()
            } else {
                self.entries.len() - usize::from(self.cleanup_id.is_some()) < MAX_PENDING
            }
    }
    fn next(&self, cleanup: bool) -> Option<CallId> {
        if !self.has_capacity(cleanup) {
            return None;
        }
        Some(CallId {
            generation: self.generation,
            sequence: self.last_id.checked_add(1)?,
        })
    }
    pub fn admit(&mut self, id: CallId, value: T) -> bool {
        self.admit_class(id, value, false)
    }
    pub fn admit_cleanup(&mut self, id: CallId, value: T) -> bool {
        self.admit_class(id, value, true)
    }
    fn admit_class(&mut self, id: CallId, value: T, cleanup: bool) -> bool {
        if !self.has_capacity(cleanup)
            || id.generation != self.generation
            || id.sequence <= self.last_id
        {
            return false;
        }
        self.last_id = id.sequence;
        if cleanup {
            self.cleanup_id = Some(id);
        }
        self.entries.insert(id, value);
        true
    }
    pub fn take(&mut self, id: CallId) -> Option<T> {
        if self.cleanup_id == Some(id) {
            self.cleanup_id = None;
        }
        self.entries.remove(&id)
    }
    pub fn pending(&self) -> impl Iterator<Item = (&CallId, &T)> {
        self.entries.iter()
    }
    pub fn get_mut(&mut self, id: CallId) -> Option<&mut T> {
        self.entries.get_mut(&id)
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn close(&mut self) {
        self.closed = true;
        self.cleanup_id = None;
        self.entries.clear();
    }
    pub fn cancel_regular(&mut self) {
        self.entries.retain(|id, _| Some(*id) == self.cleanup_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completions_are_owned_send_values_and_preserve_exact_identity() {
        fn requires_send<T: Send>() {}
        requires_send::<Completion>();
        let completion = Completion {
            id: CallId {
                generation: 4,
                sequence: 1,
            },
            result: Err(ControlFailure::ExecutionFailed),
        };
        let encoded = serde_json::to_string(&completion).unwrap();
        let decoded: Completion = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.id, completion.id);
        assert_eq!(decoded.result, completion.result);
    }

    #[test]
    fn ledger_rejects_duplicate_stale_unknown_and_late_terminals() {
        let mut guest = CallLedger::new(2);
        let first = guest.next_id().unwrap();
        assert!(!guest.admit(
            CallId {
                generation: 1,
                sequence: 1
            },
            "stale"
        ));
        assert!(guest.admit(first, "original"));
        assert!(!guest.admit(first, "replacement"));
        assert_eq!(
            guest.take(CallId {
                generation: 1,
                sequence: first.sequence
            }),
            None
        );
        assert_eq!(
            guest.take(CallId {
                generation: 2,
                sequence: 999
            }),
            None
        );
        assert_eq!(guest.take(first), Some("original"));
        assert_eq!(guest.take(first), None);
        assert!(!guest.admit(first, "replay"));
        assert_eq!(guest.next_id().unwrap().sequence, 2);
        guest.close();
        assert_eq!(guest.next_id(), None);
        assert!(!guest.admit(
            CallId {
                generation: 2,
                sequence: 2
            },
            "closed"
        ));
    }

    #[test]
    fn ledger_limits_are_reusable_without_reusing_ids() {
        let mut ledger = CallLedger::new(1);
        for _ in 0..MAX_PENDING {
            let id = ledger.next_id().unwrap();
            assert!(ledger.admit(id, ()));
        }
        assert_eq!(ledger.next_id(), None);
        let close = ledger.next_cleanup_id().unwrap();
        assert!(ledger.admit_cleanup(close, ()));
        assert_eq!(ledger.next_cleanup_id(), None);
        assert_eq!(ledger.next_id(), None);
        assert_eq!(ledger.take(close), Some(()));
        ledger.take(CallId {
            generation: 1,
            sequence: 1,
        });
        assert_eq!(ledger.next_id().unwrap().sequence, MAX_PENDING as u64 + 2);
        ledger.last_id = u64::MAX;
        assert_eq!(ledger.next_id(), None);
        ledger.close();
        assert!(ledger.is_empty());
    }
}
