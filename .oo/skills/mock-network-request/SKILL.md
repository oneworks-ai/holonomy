---
name: mock-network-request
description: Install and verify declarative process-scoped Holonomy Network Mock rules through OpenAPI. Use when an agent must match HTTP method, origin, path, query, headers, or body; return a bounded response; force a stable failure; or allow passthrough without executing scripts.
---

# Mock Network Request

1. Read the target process and its current generation. Never install a rule on an implicit or stale process.
2. Read the process’s current Network Rules resource and record its revision. For initial rules, include the complete set in process creation so installation occurs before the entry module.
3. Build one complete rule set with at most 256 rules and at most 1 MiB serialized data. Prefer exact declarative matchers; do not use regular expressions, JavaScript, templates, files, or shell commands.
4. Replace the set with `PUT /v1/processes/{id}/network/rules`, `If-Match`, `Idempotency-Key`, and `expectedGeneration`.
5. Wait for the operation and rule resource to become active. A revision applies only to newly admitted exchanges; in-flight requests keep their previous snapshot.
6. Verify the match through process output or an Inspector Network lease. Check request method, canonical URL, response source, status, and terminal event.
7. Remove or replace only the rule set created by this workflow. On revision conflict, re-read and deliberately reconcile rather than overwriting another client.

Read [references/rule-schema.md](./references/rule-schema.md) before constructing query, header, body, lifetime, or sensitive-value matchers.
