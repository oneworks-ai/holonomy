# Android Session control host

Read [../AGENTS.md](../AGENTS.md). This module owns typed command-v2 supervision, same-app ingress, local-abstract transport and the app-private journal; it does not own public JS semantics or another engine.

`AndroidRuntimeSessionSupervisor` allocates and publishes output under its existing lock. `StoredSessionSupervisorEventSink` owns durable lifecycle state/results and the bounded output journal. The concrete Service must pair it with `StoredSessionCommandHandler.withEventOwnedSnapshots`; the legacy two-argument handler mirrors captured reply snapshots and must not also write into an event-owned store.

Late reply captures must not overwrite newer events. Do not compare lifecycle phases using an invented rank: the schema has no state revision. Durable state output cursors are lifecycle-point snapshots; fresh Status replies and journal windows are current. Verify snapshot ownership, same/cross-generation events, empty output and producer ordering in module-local JVM tests, then the real Service instrumentation case. These tests do not replace shared JS conformance or developer CLI E2E.
