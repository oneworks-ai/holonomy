# Storage capability

`src/kernel/` owns Storage Policy, selection, invocation mapping and result validation.
`src/host/storage-provider.ts` owns the single platform-neutral Host Broker Provider,
copied-payload table, byte commitments, Host limit intersection, dispatch settlement
leases and asynchronous native-job cancellation. `createNativeStorageProvider` is
an alias of `createHostStorageProvider`; the Desktop bootstrap only re-exports it.

Adapters implement `StorageNativePortV1.storageStart(command) -> { id, promise }`
and `storageCancel(id)`. Native I/O, directory/namespace allocation, SQLite workers
and engine-thread completion routing remain Adapter responsibilities. Shared Host
code must not import adapters, filesystem, Node or OS modules. It reuses the
existing Broker, NativeBridge and Storage Kernel contracts; do not add another
Policy parser, request controller or resource ledger.

The deterministic Host port contract is covered by the Adapter owner's
`adapters/desktop/v8-host/tests/storage-provider*.test.ts` suites. Fake ports prove
Host glue only; real Native and Android acceptance remain separate gates.
