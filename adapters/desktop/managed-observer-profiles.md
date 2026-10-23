# Service Native diagnostic profiles (experimental)

[简体中文](managed-observer-profiles.zh-Hans.md) · [Isolated executor](observer-profiles.md)

The Service owner installs Native diagnostic modules privately. A public Native Runtime request selects only logical `initialObserverIds`; it cannot submit a callback, module source, Host path or sink path. A same-named Node function is not Native installation authority.

## Owner installation

Use an isolated Service home for this example:

```sh
export HOLONOMY_HOME="$PWD/private/holo-service"
mkdir -p "$HOLONOMY_HOME/modules"
chmod 700 "$HOLONOMY_HOME" "$HOLONOMY_HOME/modules"
```

Install a compatible Rust `holo` binary using `HOLONOMY_HOME/native-runtime.json`, mode `0600`:

```json
{ "schemaVersion": 1, "executablePath": "/absolute/owner-selected/holo" }
```

Create `HOLONOMY_HOME/modules/diagnostic.mjs`:

```js
export default (event, config, sink) => {
  if (event.event === 'script.compiled') sink.publish()
}
```

Create `HOLONOMY_HOME/native-observer-profiles.json`, then set that manifest to mode `0600`:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "monitor": {
      "use": "./modules/diagnostic.mjs",
      "export": "default",
      "config": {},
      "registration": {
        "acceptHighCost": true,
        "events": ["script.compiled"],
        "maxQueuedEvents": 16,
        "callbackTimeoutMs": 1000
      },
      "sink": { "maxBytes": 1048576 }
    }
  }
}
```

Missing manifest means no installed profiles. Unknown fields, unsafe file ownership/permissions, malformed registration/source/schema/integrity or a present manifest without an installed Native binary fail Service startup. The manifest is read from a bounded regular no-follow file, at most 1 MiB, belonging to the current OS user.

`use` resolves relative to this manifest, not the caller's project. Resource preparation reuses the Native private source reader and existing Host bundle collector, not ambient Node source reads or module execution. Optional top-level `pluginRoots` allows explicitly selected absolute sources under those roots; the current self-contained ESM/package/pnpm subset is unchanged. Up to four profiles are installed; IDs are safe 1–64-byte identifiers. Config is bounded to 64 KiB, sources to 1 MiB/file, 4 MiB aggregate and 128 files. `integrity`, when present, pins the existing bundle digest, not only the entry file.

`sink` may be omitted for the 1 MiB default. Its only accepted field is `maxBytes`, integer 1024–16777216. File locations are always derived by Service; no owner-module value is reinterpreted as a public caller path.

## Select a profile

In the caller project, create `runtime.json`:

```json
{
  "schemaVersion": 1,
  "context": { "schemaVersion": 1 },
  "initialMiddlewareId": "service.continue.v1",
  "initialObserverIds": ["monitor"],
  "sandboxPolicy": {
    "schemaVersion": 2,
    "diagnostics": {
      "sourceReader": "none",
      "maxSourceReadBytes": 0,
      "observerEvents": ["script.compiled"],
      "maxQueuedEvents": 32,
      "maxObserverCallbackMs": 1000,
      "retentionMs": 0
    }
  }
}
```

Create `index.mjs`:

```js
console.log('MANAGED_PROFILE_APP_OK')
await new Promise(resolve => setTimeout(resolve, 500))
```

```sh
holonomy run ./index.mjs --target native --capability-runtime ./runtime.json --detach
```

Both `run` and `test` select profiles this way. The caller CLI still needs its own compatible Native installation for source preflight when the target Service is remote. It does not need or receive the server's private diagnostic module. The timer merely keeps this small example alive briefly; lossy diagnostic delivery is not guaranteed by a duration.

Every selected profile is checked against this request's Policy, actual Native descriptor and Host caps. Unknown IDs, missing Native installation, Node-only bindings, unsupported events, insufficient limits or wrong versions fail before Guest entry. Installing the registry alone does not enable a profile; an empty ID list stages none. Node and Android continue using their existing target-specific rules.

## Snapshot, generation and output

Service startup freezes source/config/registration/sink-limit snapshots and computes a canonical version digest. Editing files does not mutate a running Service's installed resources; the owner must restart it. A process request privately pins the selected versions. After a Service restart, changed/missing profiles cannot silently replace an old request's code: create a new admitted Runtime request for the new installation.

Each process generation gets separate private module resources and output. With the default Service state layout, the owner can inspect:

```text
HOLONOMY_HOME/state/native-processes/<processId>/g<generation>/host/observer-output/monitor.jsonl
```

That is an owner filesystem location, **not** a public API/Guest path. A custom state directory changes its physical prefix. Public process/operation DTOs and ordinary logs do not expose profile source/config, installation paths or sink locations. This increment does not add an authenticated remote event-export endpoint or copy sink records into Guest stdout.

Normal plugin-array watch keeps the profile selection/resources unchanged. Restart uses new generation-owned resources and sink sessions; process removal cleans them through the existing owned-generation lifecycle. Output is best-effort and may be lost on saturation/terminal cleanup. See [isolated profile limits and record schema](observer-profiles.md#private-output).

## Clean up the example

The detached command returns a process ID. Save any private output you need before removing that process; removal also removes its owned Native generation files. If it is still running, stop it with `holonomy process stop <process-id>`, then:

```sh
holonomy process remove <process-id>
holonomy service stop --drain
```

The final command is for this example's isolated `HOLONOMY_HOME`; do not drain a shared Service used by other applications.

The module still runs only in the capability-free same-binary helper, with deadlines, bounded restart and owner-EOF cleanup. Existing inline Observer closures remain partial; they are not serialized or migrated. SourceReader, durable source-read audit, Device and Process installations are independent. Current executable evidence is macOS arm64, not complete Native/M4, all-platform or production-release acceptance.
