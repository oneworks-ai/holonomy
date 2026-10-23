# Native v86 Device and System bridge

[简体中文](process-v86-capabilities.zh-Hans.md) · [Host configuration](host-configuration.md)

An explicitly installed Experimental Native v86 environment can use the image's `hoholo` client to read selected Host Device/System capabilities. It re-enters the same Kernel, Policy, Cordis middleware and existing Provider/projection; Linux virtual hardware and `/proc` are not substitutes for Host information. Domains are disabled by default.

## Host selection

First configure the feature build, pinned image, private manifests and `--experimental-v86-process` as described in [Host configuration](host-configuration.md). In the selected private Process profile, set:

```json
{
  "environment": {
    "allowedScopes": ["processTree"],
    "defaultScope": "processTree",
    "capabilityBridge": { "domains": ["device", "system"] }
  }
}
```

This is a profile fragment, not a complete manifest. Also install the logical `hoholo` executable ID pointing to `/usr/bin/hoholo`, and explicitly allow it in Process Policy. Runtime code cannot select domains, another image, or another native executable path.

Domains only select a bridge; they grant no Device or System authority. For example, merge these fields into the existing Host configuration and its SandboxPolicy:

```json
{
  "deviceProvider": { "implementation": "builtin.darwin-device-v1" },
  "systemProjection": {
    "schemaVersion": 1,
    "fields": {
      "os.arch": { "mode": "synthetic", "precision": "exact", "value": "x64" }
    }
  },
  "sandboxPolicy": {
    "schemaVersion": 2,
    "systemInformation": {
      "defaultMode": "unavailable",
      "fields": {
        "os.arch": { "allowedModes": ["synthetic"], "maxPrecision": "exact" }
      }
    },
    "device": {
      "defaultAccess": "deny",
      "maxEventsPerSecond": 1,
      "maxQueuedEvents": 0,
      "maxSubscriptions": 0,
      "operations": {
        "device.summary.read": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 1
        },
        "device.form-factor.read": {
          "access": "allow",
          "maxPrecision": "coarse",
          "maxPrivacyTier": 0
        }
      }
    }
  }
}
```

The fragment does not itself enable Process. Keep the previously configured Process Policy and private profile selection. `x64` is an intentionally selected synthetic projection, not a claim about the Host or VM architecture. Other System fields require their own selected typed values, mode and precision ceilings.

## Commands and permissions

| Linux command                                | Result                                                       |
| -------------------------------------------- | ------------------------------------------------------------ |
| `hoholo system read os.arch`                 | JSON value from the selected Host field                      |
| `hoholo device summary`                      | Typed Summary; each child requires its own permission        |
| `hoholo device read device.form-factor.read` | Typed individual reading with status, precision and revision |

Invoke the logical ID with the existing JS API, for example `execFile('hoholo', ['system', 'read', 'os.arch'], { encoding: 'utf8' }, callback)`. This is a Linux executable, not a Host shell or the npm CLI. Success returns JSON on stdout. Refusal returns exit 1 and a fixed machine code on stderr, not native exceptions or paths.

Host middleware receives the environment, executable ID, Linux PID, process resource and synthetic process ID in `request.source`. Parent/root PID and start ticks are included only when the trusted protocol has reported them. In particular, the current one-shot capability path may omit start ticks; it does not substitute a guessed value. Independent process invocations have distinct environment/resource identities. System operations retain their Registry's synchronous semantics, so their handlers must be synchronous; the Device Promise operations may use asynchronous handlers. A System field granted by Policy can still be refused by Host middleware.

The example permits only form-factor inside Summary. Display, input, lifecycle and power remain `permissionDenied`, precision `none`, revision 0, without a value. Tier 2 state and Wi-Fi identity never enter Summary. Unsupported commands and event subscriptions are refused; this one-shot wire is not a Linux event stream. Direct JS Device subscriptions remain a separate API.

The shared bridge caps concurrent calls at 64 and each call at 30 seconds, subject to earlier Kernel/Process cancellation. A cancelled or timed-out underlying invocation retains its bounded slot until settlement; late results cannot replace the chosen response. A nonsettling trusted handler requires the normal Runtime teardown rather than an assumption that a Promise can be killed.

## Verification and scope

After the feature build, run `HOLO_V86_PRODUCTION_ASSET_ROOT=/absolute/verified-agent pnpm test:native:v86-capability`. It executes actual empty-PATH `holo test`: seven enabled-domain Guest JS cases and one closed-domain case. The Host driver only installs fixtures and checks the reports; Node is not the selected Runtime.

Current evidence is macOS arm64 with the pinned agent image. It covers actual `hoholo`, Host projection selection, Native Device reads, privacy clipping, source-aware middleware and default-closed domains. It does not establish physical Device change delivery, Linux event subscriptions, arbitrary native Device APIs, other platform parity or promotion beyond Experimental. Plugin config watch cannot widen Policy, profile domains or the selected Provider.
