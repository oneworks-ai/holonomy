import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel/errors'
import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import { canonicalizeStorageKvResourceV1, canonicalizeStorageSqlResourceV1 } from './storage-resources.js'

export const routeStorageInvocationV1 = (member: string, args: JsonValueV1 | undefined) => {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
  }
  const value = args as Readonly<Record<string, JsonValueV1>>
  const namespaceId = value.namespaceId
  try {
    if (member.startsWith('kv.')) {
      const selector = member === 'kv.list' ? 'prefix' : 'key'
      return {
        preferredProviderModule: 'host.storage',
        resource: canonicalizeStorageKvResourceV1(namespaceId, selector, value[selector])
      }
    }
    if (member.startsWith('sqlite.')) {
      return {
        preferredProviderModule: 'host.storage',
        resource: canonicalizeStorageSqlResourceV1(namespaceId, value.database)
      }
    }
  } catch {
    throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
  }
  throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
}
