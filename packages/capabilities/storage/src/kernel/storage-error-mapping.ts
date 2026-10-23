import type { StorageErrorCode } from '@holonomyjs/runtime/storage/errors'

const codes: Readonly<Record<string, StorageErrorCode>> = Object.freeze({
  'holo.capability_denied': 'storage.authorization_denied',
  'holo.generation_stale': 'storage.cancelled',
  'holo.invalid_arguments': 'storage.invalid_argument',
  'holo.invalid_result': 'storage.protocol_error',
  'holo.operation_cancelled': 'storage.cancelled',
  'holo.operation_timeout': 'storage.timeout',
  'holo.permission_denied': 'storage.authorization_denied',
  'holo.policy_denied': 'storage.authorization_denied',
  'holo.protocol_error': 'storage.protocol_error',
  'holo.resource_exhausted': 'storage.limit_exceeded'
})

/** Map only Kernel's closed Holo family into the already public Storage error family. */
export const mapStorageKernelErrorV1 = (error: unknown): StorageErrorCode => {
  if (error == null || typeof error !== 'object') return 'storage.internal'
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? codes[code] ?? 'storage.internal' : 'storage.internal'
}
