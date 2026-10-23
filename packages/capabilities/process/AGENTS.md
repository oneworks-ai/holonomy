# Process capability

`src/kernel/guest-child-process-resources.ts` owns Guest-local ChildProcess,
stdin and pipe facade state. `src/host/` owns the Backend-neutral Host Provider
and resource ledger. Platform adapters own OS and VM I/O.

ChildProcess and readable listener APIs are local callback bookkeeping only:
they must not create authority, operations, Host subscriptions or a second
resource table. Keep their delivery snapshot-based, preserve duplicate callback
registration and original callback identity for `once` removal, and clear local
listener references after terminal close. Removing a local listener does not
physically cancel the Host event subscription; Resource Registry/SPI close and
generation fencing remain its owner.

Do not broaden `node:child_process` into ambient spawn, PATH lookup, shell
access, IPC or Node streams. Public operation rows stay in
`src/kernel/process-registry*.ts`; change them only when an actual Host-facing
operation changes. Normal verification is focused Guest-runtime tests plus the
configured Native profile conformance route; no device run is implied here.
