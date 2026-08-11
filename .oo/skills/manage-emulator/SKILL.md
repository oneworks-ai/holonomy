---
name: manage-emulator
description: List, start, stop, and restart Android emulators owned by the Holonomy Service. Use when an agent needs an emulator for Runtime execution or conformance and must distinguish service-owned AVD instances from physical devices and external emulators.
---

# Manage Emulator

1. List `/v1/emulators` and `/v1/devices` before mutating anything.
2. Start an AVD through the emulator OpenAPI with an `Idempotency-Key`. Record the emulator id, owner instance, nonce, and resulting serial.
3. Wait until the corresponding device is online before launching a Runtime. Treat boot timeout as a failed emulator operation, not as a usable device.
4. Stop or restart only an emulator whose owner instance and nonce identify the current Holonomy Service. Never stop a physical device, an external emulator, or a serial that merely resembles an owned instance.
5. Re-read inventory after every lifecycle operation. If ownership is lost, report `lost` and do not attempt a broad kill or ADB reboot.
6. Before stopping the Service, stop owned Runtime processes on the emulator or use the explicit Service drain workflow.

Read [references/emulator-api.md](./references/emulator-api.md) for ownership and failure semantics.
