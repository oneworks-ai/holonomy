# Manage Android emulators

[简体中文](../../guides/manage-emulators.md)

The Holonomy Service manages only AVDs that it started and whose ownership evidence still matches. Physical devices and externally started emulators may appear in device inventory, but Holonomy cannot stop or restart them.

## Inventory

```sh
pnpm holonomy emulator list
pnpm holonomy device list
```

An Emulator resource represents a managed AVD lifecycle. A Device resource represents a currently observed ADB endpoint. They are not the same resource.

## Start

```sh
pnpm holonomy emulator start Pixel_8_API_35 --wait
```

`--wait` waits until the device is usable. Save the returned emulator ID. Later lifecycle operations use this stable ID instead of guessing a launcher PID.

## Restart and stop

```sh
pnpm holonomy emulator restart <emulator-id> --wait
pnpm holonomy emulator stop <emulator-id>
```

The Service jointly verifies the durable owner record, AVD name, serial, launcher PID, and random nonce. Missing evidence, PID reuse, or an externally owned process fails closed and never triggers a kill attempt.

A regular `service stop` returns a conflict while a managed emulator exists. Only an explicit `service stop --drain` cleans up emulators owned by the current Service.

See [OpenAPI](../openapi/index.md) for Device and Emulator HTTP resources.
