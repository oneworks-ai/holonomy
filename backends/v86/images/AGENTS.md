# v86 Linux image assets

This directory owns reproducible, Host-selected Linux image profiles for the v86 Backend. Runtime JavaScript never
selects a profile and never installs software. `build-image.mjs` consumes a checked-in source/package lock, a trusted
`holo-uvd` ELF, and a strict profile, then emits a deterministic `newc` initramfs, manifest, and SPDX SBOM.

- `minimal` contains only `/sbin/holo-uvd` and directories created by the image builder.
- `base` adds the pinned Alpine x86 minirootfs, including BusyBox, `/bin/sh`, and `/bin/cat`.
- `agent` adds the exact locked closure for curl, CA certificates, git, OpenSSH client, and jq.
- `custom` profiles use the same schema and may only reference packages present in a regenerated package lock.

Source updates are explicit: update `alpine-source-v1.json`, run `resolve-alpine-lock.mjs` in a networked trusted build
environment, review the complete diff, and then run two independent image builds plus `verify-image.mjs`. Do not check
download caches, extracted root filesystems, generated initramfs images, or production credentials into the repository.

`newc.mjs` is the single deterministic archive encoder for production builds and test-only conformance overlays. Production
verification must reject the `/usr/bin/holo-v86-selftest` fixture even when an overlay is otherwise structurally valid.
