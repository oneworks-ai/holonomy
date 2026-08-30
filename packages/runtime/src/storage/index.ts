export {
  DEFAULT_STORAGE_LIMITS,
  assertStorageCapability,
  createStorageAuthority,
  createStorageAuthorityRegistry,
  nativeAuthorityForStorage,
  requireStorageCredentialBinding,
  resolveProviderStorageAuthority,
  snapshotStorageRecord
} from './authority.js'
export * from './capabilities.js'
export * from './constants.js'
export { STORAGE_PROVIDER_CONTRACT, parseStorageEnvelope, storageFailure, storageSuccess } from './contract.js'
export type { StorageFailureEnvelope, StorageSuccessEnvelope } from './contract.js'
export * from './errors.js'
export * from './facade.js'
export type * from './types.js'
