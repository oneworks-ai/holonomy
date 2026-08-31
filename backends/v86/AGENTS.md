# v86 Backend family

This directory owns platform-neutral v86 Linux assets and reproducible probes:

- `kernel/` pins and verifies the Linux kernel configuration.
- `supervisor/` implements the in-Guest process/FUSE/exec-gate protocol installed as `/sbin/holo-uvd`.
- `build-supervisor.mjs` builds the Guest daemon and initrd assets.
- `build-conformance-image.mjs` overlays a freshly built daemon, capability client and private fixture onto a verified
  `base` or `agent` production image so real probes retain the production kernel modules and userspace.
- `probe-*.mjs` are lower-level Host-V8/backend probes, not public Runtime conformance.

Node Host loading, Registry installation and V8 process ownership remain in `adapters/node/src/capability-process-v86-*`. Android asset packaging and Javet process ownership remain in `adapters/android/process-backend-v86/`. Do not duplicate those platform responsibilities here.

The Guest supervisor is infrastructure and is not shipped as a public self-test. The conformance overlay is a test-only
artifact and must never be packaged as a production profile. Filesystem/network/device/system access must re-enter shared
Capability authority; a successful stock v86 boot is never enough to claim public support.
