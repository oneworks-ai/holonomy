# Conformance usage and evidence

[简体中文](../../testing/conformance.md)

Conformance runs the same `node:test` files through the real `holonomy test` entry point. It verifies the complete developer path: CLI → Service → Adapter → shared Runtime → public JavaScript API.

```sh
pnpm holonomy test "conformance/specs/**/*.test.mjs" \
  --target node \
  --sandbox conformance/sandbox/restricted.json \
  --reporter json
```

Android uses the same files:

```sh
pnpm holonomy test "conformance/specs/**/*.test.mjs" \
  --target android \
  --device emulator-5554 \
  --sandbox conformance/sandbox/restricted.json \
  --reporter json
```

Ordinary `describe`/`it` cases define the cross-platform common denominator. A missing capability fails instead of being skipped automatically. `describe.holonomy.android` and `it.holonomy.android` declare an explicit platform-only promise, are reported separately, and do not enter the common denominator.

Android instrumentation is Adapter integration evidence, not CLI E2E. Emulator evidence is labeled `emulator`; only an actual connected physical device execution can be labeled `physical`.

The current common conformance covers Console, Timers, `node:path`, `node:buffer`, module URLs, Fetch JSON, and Fetch abort.
