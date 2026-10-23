# GitHub automation

`workflows/ci.yml` owns pull-request and `main` checks. It reuses package scripts for shared JavaScript/contracts, standalone macOS Native tests, and Android JVM/SDK builds. Android device and experimental v86 acceptance remain separate real-runtime gates; these jobs do not claim to run them.

Native packaging requires macOS arm64 and runs through `pnpm test:native` in the Native macOS job. Do not duplicate that platform-specific packaging invocation in the Linux JavaScript job.

Keep workflow permissions read-only and action revisions pinned. CI must not publish packages, create releases, access user devices, or require private local configuration. Change the owning package script instead of copying its test list into workflow shell code.
