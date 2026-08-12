# Android platform

[简体中文](../../../platforms/android/index.md)

Android uses a non-UI foreground Supervisor to manage multiple logical V8 runtimes. Each Runtime has its own engine, runtime thread, generation, NativeHost, output sequence, and Inspector socket.

The Service owns ADB discovery, installation, command-v2 transport, forward/reverse leases, log consumption, and recovery. The device exposes no TCP control listener. Full commands stay in the app-private directory, while the exported compatibility ingress accepts only a random command ID.

The current isolation mode is `runtime`: logical V8 isolation inside one Android application process. `isolatedProcess` returns a stable unsupported error.

The network provider independently enforces authority, DNS address admission, socket/TLS behavior, quotas, cancellation, and streaming credit. The shared JavaScript Runtime still owns Fetch, redirect, Request, Response, and Abort semantics.

Emulators and physical devices use the same product path, but acceptance reports must identify them separately. Emulator evidence cannot be reported as physical-device evidence.

More information: [Session Host](../../../../../adapters/android/session-host/README.md) · [Network Provider](../../../../../adapters/android/network-host/README.md)
