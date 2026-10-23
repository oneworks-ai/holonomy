# Development artifact archive

`archive.mjs` owns exact manifest membership, nofollow regular-file inventory and deterministic USTAR metadata for POSIX development bundles. Native packaging retains its private/executable mode policy through its compatibility wrapper; Android SDK packaging supplies its own executable list. This module never builds, executes a delivered runtime, signs or publishes.

Keep the existing Native archive regression tests passing when changing this shared owner. SDK verification additionally checks the bounded decompressed USTAR file types, membership and hashes before using any archive content. Do not introduce recursive discovery, filesystem metadata members, symlinks or hardlinks.
