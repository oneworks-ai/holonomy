# Android Runtime Host

Read [../AGENTS.md](../AGENTS.md) and [README.md](README.md). This module owns production JavaScript bootstrap, Android transport composition and asset packaging. The shared Runtime and NativeBridge remain in `packages/runtime`; diagnostic controls and fixture generation remain in `e2e`.

`src/runtimeBootstrap/runtime-host.mjs` is the unique Guest transport/composer; `plugin-host.mjs` owns Host-realm Cordis and the shared Broker. Private Engine driver globals are captured/removed before Guest entry. Network rules control remains a mandatory private ABI; the E2E diagnostic object is excluded from production assets.

`android-storage-provider.mjs` only adapts async native jobs to the shared Host Storage provider. Native cancel need not emit a terminal: settle its private Promise in finally so shared tracked.settled releases the lease, and discard late IDs. Logical settlement is not physical worker termination. `android-crypto-provider.mjs` uses captured internal-slot binary copies and wipes owned temporary wire packets.

Tests under `tools/__tests__` verify actual production assets/bootstrap and controlled async job lifecycle. They never replace real Javet/device acceptance. Asset generation owns only its explicitly supplied output directory.

The packager resolves scoped Runtime packages through installed dependency entries, not a required monorepo packages/ tree. Canonicalize its source/compiled/bootstrap roots together: npm/pnpm CLI symlinks and physical import.meta.url paths must not produce ../.pnpm provenance. Keep production bootstrap/tools in the root npm files allowlist and the installed-layout package gate.
