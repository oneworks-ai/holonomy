# Native Runtime Observer (partial)

[简体中文](observer.zh-Hans.md) · [Host configuration](host-configuration.md)

This guide describes **inline** Observer callbacks in trusted Host Cordis plugins. For a separate capability-free helper/isolate and bounded private output, use experimental [isolated diagnostic profiles](observer-profiles.md). Neither mode exposes an Observer API to Guest JavaScript or produces authorization decisions.

## Direct standalone entry

Create `host.json`:

```json
{
  "schemaVersion": 1,
  "sandboxPolicy": {
    "schemaVersion": 2,
    "diagnostics": {
      "sourceReader": "none",
      "maxSourceReadBytes": 0,
      "observerEvents": ["script.compiled", "runtime.terminated"],
      "maxQueuedEvents": 16,
      "maxObserverCallbackMs": 50,
      "retentionMs": 0
    }
  },
  "plugins": [{ "id": "monitor", "use": "./monitor.mjs" }]
}
```

Create `monitor.mjs`:

```js
export default ctx => {
  const recent = []
  ctx.holo.observe({
    acceptHighCost: true,
    events: ['script.compiled', 'runtime.terminated'],
    maxQueuedEvents: 16,
    callbackTimeoutMs: 50
  }, event => {
    if (recent.length === 16) recent.shift()
    recent.push(event)
  })
}
```

This example consumes metadata in bounded Host-plugin memory; it does not print or export events. The self-contained Native Host plugin environment does not install a bounded Host-owned log/event export route or ambient Host I/O. An engine-provided console object alone does not establish a usable output sink. A complete configurable external telemetry sink is not delivered by this example or by enabling Observer Policy. Ordinary Guest stdout is not an Observer feed.

Put `console.log('OBSERVER_GUEST_OK')` in `index.mjs` and run:

```sh
holo --timeout 3000 --host-config ./host.json ./index.mjs
```

Expected Guest stdout: `OBSERVER_GUEST_OK`. No source-reading permission is needed for Observer metadata. A plugin requesting an event outside Policy, an unsupported event, or a high-cost event without `acceptHighCost: true` fails installation before Guest entry.

## Managed Native entry

Install the Native binary in an owner-only Service home as described in [Managed Engine Gates](managed-engine-gates.md#setup). Use the same `monitor.mjs` with a plugin-only `holo.config.json`:

```json
{ "plugins": [{ "id": "monitor", "use": "./monitor.mjs" }] }
```

Create a separate `runtime.json` by copying only `sandboxPolicy` from the direct configuration above:

```json
{
  "schemaVersion": 1,
  "context": { "schemaVersion": 1 },
  "initialMiddlewareId": "service.continue.v1",
  "initialObserverIds": [],
  "sandboxPolicy": {
    "schemaVersion": 2,
    "diagnostics": {
      "sourceReader": "none",
      "maxSourceReadBytes": 0,
      "observerEvents": ["script.compiled", "runtime.terminated"],
      "maxQueuedEvents": 16,
      "maxObserverCallbackMs": 50,
      "retentionMs": 0
    }
  }
}
```

```sh
holonomy run ./index.mjs --target native --config ./holo.config.json --capability-runtime ./runtime.json
```

Inline Native registration belongs to the Host plugin's `ctx.holo.observe` call, installed before Guest entry. Separately, [Service Native profiles](managed-observer-profiles.md) use owner-installed module resources selected by `initialObserverIds`. Unknown or Node-only IDs are rejected; Node callback bindings and limits do not authorize Native subscriptions. Plugin-array watch disposes removed inline subscriptions but does not replace isolated profiles or widen the frozen diagnostics Policy. Static plugin startup also works with `holonomy test`.

## Support and bounds

The single Native platform descriptor is used by both Service admission and the Native Host registry. It currently declares:

- Optional: `script.compiled`, `script.execution-started`, `script.execution-finished`, `runtime.exception`, `runtime.terminated`.
- Script events are high-cost and require explicit opt-in at subscription.
- Unsupported: `gc.completed`, `memory.pressure`, `promise.rejected`. Native Service rejects these Policy selections before entry rather than pretending to provide them.
- Host ceilings: 256 queued events and a 1,000 ms asynchronous callback deadline. Effective limits are the minimum of subscription, Policy, platform and Host ceilings. Omitted subscription timeout inherits that minimum; zero/negative/fractional timeout values are invalid.

Events carry `schemaVersion`, `event`, per-isolate `generation`, monotonic `observedAt`, `sequence` and a closed payload. Compilation has a virtual origin, script ID and source byte count/digest—not source text. Execution events identify explicit module/CommonJS roots; they do not cover every implicit dependency or eval/Function invocation. Exception/terminal events carry fixed codes/reasons, not messages, stacks, bodies or Host Context. Native isolate generation starts at 1; Service process generations are a separate outer lifecycle identity.

Delivery is bounded and lossy. The engine queue has 64 slots and at most 8 KiB per owned message, separate from Gate command capacity. Subscriber overflow is coalesced and counted; optional events and terminal delivery can be lost. Do not infer an exact start/finish pair or complete audit history. Closing/disposal fences subsequent deliveries, and asynchronous callbacks do not keep Guest terminal open.

Observer results are not consumed as Gate decisions. However, current inline callbacks share Host-plugin closure state and can influence that plugin's subsequent Gate/Middleware logic. This partial implementation therefore does not enforce monitoring/authorization non-interference; a callback return type or separate event queue is not proof of that stronger isolation.

Throwing or asynchronously stalled callbacks produce fixed, source-free diagnostics such as `holo observer callback.failed runtime.terminated`; private exception text is not logged. A synchronous infinite inline callback can indefinitely block the trusted Host worker: whole-generation termination requires an explicit Runtime deadline, cancellation or another fatal watchdog condition. Standalone `holo` has no deadline by default; the example explicitly sets `--timeout 3000`. **Inline closures do not acquire independent executor isolation.** An asynchronous timeout cannot preempt synchronous JavaScript. Use the separately selected [diagnostic module mode](observer-profiles.md) for that boundary; inline Observer must not be a required authorization/availability dependency.

The [bounded source reader](engine-gate.md#bounded-source-reader), its optional durable audit sink and [Desktop Device](device.md) are independent installations. This partial Native support is not complete M4, Android/Windows, or production-release acceptance.
