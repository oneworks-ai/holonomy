# Native Desktop Device

[简体中文](device.zh-Hans.md) · [Host configuration](host-configuration.md)

Native macOS arm64 `holo` can explicitly install the Desktop Device Provider. It uses read-only CoreGraphics/IOKit metadata, the shared `holo:device` facade and the existing Policy/Broker. It is not installed by default, and a selection alone grants no Device access.

## Standalone configuration

Create `host.json`:

```json
{
  "schemaVersion": 1,
  "deviceProvider": { "implementation": "builtin.darwin-device-v1" },
  "sandboxPolicy": {
    "schemaVersion": 2,
    "device": {
      "defaultAccess": "deny",
      "maxEventsPerSecond": 16,
      "maxQueuedEvents": 8,
      "maxSubscriptions": 2,
      "operations": {
        "device.summary.read": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 1
        },
        "device.form-factor.read": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 0
        },
        "device.display.read": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 1
        },
        "device.input.read": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 1
        },
        "device.lifecycle.read": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 1
        },
        "device.events.subscribe": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 1
        }
      }
    }
  }
}
```

Create `index.mjs`:

```js
import { getDisplay, getFormFactor } from 'holo:device'
import { subscribe } from 'holo:device/promises'

console.log(JSON.stringify(getFormFactor()))
console.log(JSON.stringify(getDisplay()))
const subscription = await subscribe({
  kinds: ['display', 'lifecycle'],
  maxQueuedEvents: 8
})
try {
  for (let index = 0; index < 2; index++) {
    const { value } = await subscription.next()
    console.log(value.kind, value.phase)
  }
} finally {
  await subscription.close()
}
```

```sh
holo --host-config ./host.json ./index.mjs
```

The first two readings reflect the current Host. The subscription starts with `display snapshot` and `lifecycle snapshot`; it holds a reference until closed. A required read may report `unavailable` or `permissionDenied` with precision `none` and no value when the OS cannot supply it. No placeholder resolution or input capability is substituted.

## Values and privacy

| Reading     | Current source and boundary                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Form factor | Bounded private model classification into `desktop` or `unknown`; raw model is not returned.                                                                                                                                                                       |
| Display     | Current primary display in logical points/CSS px, scale and orientation. `standard` omits refresh; explicit `exact` may include the OS refresh rate. HDR and wide-color are `unknown`. No image, coordinates, display ID or serial is returned.                    |
| Input       | Registered HID usage categories only. No device open, input report, key event, text or raw identifier is read. Trackpads are indirect fine pointers, not touchscreens. A touchscreen with an unknown contact limit yields unavailable rather than a guessed count. |
| Lifecycle   | Current process's console session and display-sleep metadata determine interactive state. CLI window visibility and memory pressure remain `unknown`; this is not application-window focus tracking.                                                               |

The descriptor implements the six Desktop-required operations: Summary, form-factor, display, input, lifecycle and event subscription. Other operations are declared unsupported; the current shared Broker denies those optional getters before Provider I/O instead of falling back to ambient OS APIs.

OS references: Apple's [display mode pixel API](https://developer.apple.com/documentation/coregraphics/cgdisplaymode/pixelwidth) and [registered IOKit service enumeration](https://developer.apple.com/documentation/iokit/1514494-ioservicegetmatchingservices).

`getSummary()` contains only its typed Tier 0/1 fields. Each child also needs its independent field Policy and must fit the aggregate authority. A missing child grant returns `permissionDenied`, precision `none`, revision 0 and no value, without probing that field. Summary never contains Wi-Fi identity or Tier 2 state. Its optional power field is unsupported only when that field was independently permitted; otherwise it is permissionDenied.

Coarse display projection rounds dimensions to 100-pixel buckets (minimum 1), rounds scale to half steps within 0.25–16 and omits refresh. The same operation-local Rust source revision is shared by sync/Promise getters, Summary and events; time or precision projection alone does not increment it. A revision may therefore match across different authorized views.

## Events and resync

Display/lifecycle changes are sampled at intervals of at least 250 ms while subscriptions exist. Source events share the Policy limit across subscriptions, with Host ceilings of 128 subscriptions, 128 source events/second and 256 queued events per subscription. Transient OS states can be coalesced. Closing the last subscription cancels its referenced Host timer; ordinary FS watcher `persistent:false` behavior is unchanged.

On `kind: overflow`, independently reread every kind named by `requiredRevisions`, then call `acknowledgeResync` with the successful getters' revisions. Every revision must satisfy its required minimum and be known from an event or corresponding getter; unread future revisions are rejected. ACK is valid only during resync. Late events older than the acknowledged floor cannot roll state back. Use `getDisplay()`/`getLifecycle()`, not a broader Summary permission, to resync those kinds.

Real macOS read, initial-snapshot, queue-overflow/resync, permission and generation/lifetime paths have executable evidence. Hardware display/lifecycle changes were not induced or independently observed during that validation; sampled change delivery also has controlled-source tests, not a physical-change acceptance claim.

## Service installation

For the managed Native target, the owner-only `$HOLONOMY_HOME/native-runtime.json` additionally selects:

```json
{
  "schemaVersion": 1,
  "executablePath": "/absolute/path/to/holo",
  "deviceProvider": { "implementation": "builtin.darwin-device-v1" }
}
```

Keep mode `0600`; use the matching development CLI/Service and binary. The Service reads this Host selection at startup and stages it privately. The public capability Runtime request supplies only Context, initial Middleware and the Device Policy, never an implementation selector or raw readings. See [Managed Native setup](managed-engine-gates.md) for that request/Service-home structure. Then `holonomy test ./device.test.mjs --target native --capability-runtime ./runtime.json` runs ordinary Guest JS tests.

Changing the installation or Policy requires a new Runtime/normal Service restart; plugin config watch cannot widen it. Generation close releases subscriptions and native callbacks. An ordinary OS read failure is a typed reading; an invalid private native protocol fails the isolated generation rather than inventing a revision or leaving a stale iterator silently active.
