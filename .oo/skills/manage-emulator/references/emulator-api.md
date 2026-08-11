# Emulator lifecycle API

Inventory: `GET /v1/emulators`. Lifecycle operations are `POST /v1/emulators/{id}:start|:stop|:restart` with an `Idempotency-Key` and a bounded options body.

Only a Service-created instance with matching owner instance and nonce is mutable. Physical devices and external emulators are read-only inventory. A stopped or lost instance cannot be inferred from serial presence alone; refresh devices and inspect the emulator resource.

Use cold boot or data wipe only when the task explicitly requires it. These options are destructive to the owned emulator’s state and are never an automatic recovery fallback.
