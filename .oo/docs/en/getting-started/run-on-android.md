# Run on Android

[简体中文](../../getting-started/run-on-android.md)

The Android target creates managed logical V8 Runtimes in the host application's foreground Supervisor. The Service owns device selection, APK management, ADB leases, logs, and Inspector lifecycle.

## Prerequisites

- Android SDK and ADB.
- One online Android emulator or physical device.
- Evidence must distinguish `emulator` from `physical`.

```sh
pnpm holonomy device list
```

## First program

```sh
pnpm holonomy run examples/basic.mjs \
  --target android \
  --device emulator-5554
```

Replace the device id with an explicitly selected target. Do not rely on implicit selection when several devices are online.

## Network conformance

```sh
pnpm holonomy test "conformance/specs/**/*.test.mjs" \
  --target android \
  --device emulator-5554 \
  --sandbox conformance/sandbox/restricted.json \
  --reporter json
```

The Service stages the controlled fixture and exact network authority before starting the Runtime.

## DevTools

```sh
pnpm holonomy test conformance/specs/fetch.test.mjs \
  --target android \
  --device emulator-5554 \
  --sandbox conformance/sandbox/restricted.json \
  --inspect-brk \
  --devtools
```

Stop or remove the managed process when finished. Do not replace process lifecycle with a broad `adb force-stop`.

Next: [Android platform](../platforms/android/index.md) · [Debug with DevTools](../guides/debug-with-devtools.md)
