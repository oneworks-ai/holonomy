export const storageContractVectors = api => {
  const limits = api.STORAGE_LIMIT_MAXIMA_V2
  const storage = {
    access: 'sandboxed',
    limits,
    namespaces: [{
      databases: ['main'],
      keyPrefixes: ['notes/'],
      namespaceId: 'default',
      operations: ['storage.kv.get', 'storage.kv.list', 'storage.kv.set', 'storage.sqlite.query']
    }]
  }
  const policy = api.compileSandboxPolicyV2({ schemaVersion: 2, storage })
  const key = api.canonicalizeStorageKvResourceV1('default', 'key', 'notes/alpha')
  const prefix = api.canonicalizeStorageKvResourceV1('default', 'prefix', 'notes/alpha')
  const sql = api.canonicalizeStorageSqlResourceV1('default', 'main')
  const available = {
    ...storage.namespaces[0],
    limits
  }
  const required = {
    databases: [],
    keyPrefixes: ['notes/alpha'],
    limits: { ...limits, maxValueBytes: 1024 },
    namespaceId: 'default',
    operations: ['storage.kv.get']
  }
  const narrowed = api.meetStorageCapabilityConstraintsV1(available, required)
  const invocation = JSON.parse(api.createStorageInvocationV1(
    {
      args: { key: 'notes/alpha' },
      binary: [{ base64: 'YQ==', handle: 'value' }],
      module: 'host.storage',
      operation: 'v1.kv.set'
    },
    'default',
    'native-controller:1:call:1'
  ))
  return {
    capability: {
      available,
      narrowerSatisfied: api.storageCapabilitySatisfiesV1(available, required),
      narrowed,
      required,
      widenedSatisfied: api.storageCapabilitySatisfiesV1(required, available)
    },
    invocation,
    operation: {
      invalid: [{
        schemaId: 'StorageKvSetArgsV1',
        value: { key: 'notes/alpha', namespaceId: 'default', valueByteLength: 1 }
      }, {
        schemaId: 'StorageSqlStatementArgsV1',
        value: { database: 'main', namespaceId: 'default', statement: { sql: 'SELECT 1', unknown: true } }
      }, {
        schemaId: 'StorageKvGetResultV1',
        value: { found: true, valueBase64: '!' }
      }],
      valid: [{
        schemaId: 'StorageKvSetArgsV1',
        value: invocation.arguments
      }, {
        schemaId: 'StorageKvGetResultV1',
        value: { error: { code: 'storage.not_found' } }
      }, {
        schemaId: 'StorageQueryResultV1',
        value: [[['value', 1]]]
      }]
    },
    policy: {
      invalid: [{ schemaVersion: 2, storage: { ...storage, unexpected: true } }, {
        schemaVersion: 2,
        storage: { ...storage, limits: { ...limits, maxSqlInstructions: 10_000_001 } }
      }, {
        schemaVersion: 2,
        storage: { ...storage, namespaces: [{ ...storage.namespaces[0], keyPrefixes: ['bad\uD800'] }] }
      }],
      normalized: policy.policy,
      digest: policy.digest
    },
    resources: { key, prefix, sql },
    schemaVersion: 1
  }
}
