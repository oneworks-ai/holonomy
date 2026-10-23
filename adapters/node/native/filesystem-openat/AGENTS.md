# Node filesystem openat primitive

This native addon is a Host-owned operating-system primitive. It is separate
from the V8 Engine Gate and is not a Runtime Plugin or Guest API.
`openAt(parentFd, leafName, nativeFlags, mode = 0o600)` opens one
segment relative to a caller-owned directory fd and returns a caller-owned OS
fd. The Node filesystem Provider owns authority checks, root selection,
identity verification, fd walks, truncation after verification, resource
tables, cancellation, and closing every returned fd.

The addon accepts only POSIX access flags and `O_APPEND`, `O_CREAT`, `O_EXCL`,
`O_DIRECTORY`, `O_NOFOLLOW`, `O_NONBLOCK`, and `O_CLOEXEC`. It rejects
`O_TRUNC`, applies the last three safety flags on every open, and accepts
`0600` as the only creation mode. It opens directories only when
`O_DIRECTORY` is requested and otherwise opens regular files only. Darwin
and Linux are supported; other platforms fail with `ENOSYS`.

`futimens` applies strict set/now/omit times to an already authorized fd;
`accessAt` and `accessDirectory` check real OS permissions without granting
future I/O. `readDirectoryFd` enumerates a duplicate of the pinned directory
fd with entry limits, fatal UTF-8 and nofollow type checks; it distinguishes
readdir errors from EOF and never returns a partial snapshot. The Provider
retains the original directory fd for sync/close through its existing resource
ledger. `duplicateDirectoryFd` duplicates ownership; every duplicate must be
closed by its caller. None of these primitives owns Policy or capability grants.

Only the trusted Node Host loader in `src/capability-fs-openat.mjs` may load
the fixed built addon. Never pass its function, module, or raw fds into a
Guest Context or add a Guest-configurable addon path. No runtime compilation
or network fetch belongs in this loader.
