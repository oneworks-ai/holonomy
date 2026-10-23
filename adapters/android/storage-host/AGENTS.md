# Android Storage native owner

Read [../AGENTS.md](../AGENTS.md). This module owns generation-bound asynchronous binary KV I/O, private snapshot persistence, native selection rechecks and cancellation/commit fencing. Shared facade, Policy, Broker and transport job settlement remain outside this module.

Read [.oo/rules/native-kv.md](.oo/rules/native-kv.md) for the provider-only wire/commitment and lifecycle contract. Native tests stay beside their IO or lifecycle owner; public behavior stays in shared JS conformance. SQLite and credential Providers are not implemented.
