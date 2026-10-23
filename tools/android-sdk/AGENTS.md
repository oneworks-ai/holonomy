# Android SDK packaging

package.mjs builds eight explicit debug AARs (or records an explicit skip-build), snapshots fixed sources, checks production Runtime AAR payloads and publishes only a verified manifest-derived archive. files.mjs owns the closed payload/consumer source map. inventory.mjs parses bounded USTAR without extracting untrusted content; aar.mjs only reads bounded zip output.

Reuse tools/artifact-archive for exact archive membership and last-marker publication. Never recursively copy build directories, include E2E/VM assets or local.properties, overwrite an output, or remove anything except newly-created private staging. Byte-identical archives from identical AARs are not reproducible Gradle builds, signing or device acceptance.

Run pnpm test:android:sdk and the existing Native packaging suite for shared changes. Real delivery also needs source-build packaging, extraction and an independent consumer App running shared JS on the selected emulator/device. Fake AAR unit fixtures prove only tool behavior.
