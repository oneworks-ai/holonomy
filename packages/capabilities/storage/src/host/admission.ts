import type { CapabilityProviderAuthorityV1, HoloInvocationContextV1 } from '@holonomyjs/runtime/kernel/broker-types'
import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel/errors'
import { sha256Hex } from '@holonomyjs/runtime/module-loader/sha256'
import { encodeBase64 } from '@holonomyjs/runtime/node-compat/encoding'
import { STORAGE_NATIVE_BY_OPERATION_V1, storageSelectionForProviderV1 } from '../kernel/storage-invocation.js'
import type { StorageProviderSelectionV1 } from '../kernel/storage-invocation.js'
import type { StorageLimitNameV2, StorageLimitsV2, StorageOperationV1 } from '../kernel/storage-types.js'
import type { StorageArgumentsV1, StorageBinaryV1, StorageHostInstallationV1 } from './types.js'

const selected = (
  context: HoloInvocationContextV1,
  authority: CapabilityProviderAuthorityV1,
  installation: StorageHostInstallationV1
) => {
  const resource = context.resource.requested
  const input = context.arguments as StorageArgumentsV1
  if (
    (resource.kind !== 'storageKv' && resource.kind !== 'storageSql') ||
    resource.namespaceId !== input.namespaceId || resource.namespaceId !== 'default'
  ) throw new CapabilityInvocationError('capability.denied', context.operation)
  let selection: StorageProviderSelectionV1 | undefined
  for (const binding of authority.bindings) {
    if (binding.providerModule !== 'host.storage') continue
    try {
      const candidate = storageSelectionForProviderV1(binding, context.operation as StorageOperationV1)
      if (candidate.namespaceId === resource.namespaceId) {
        selection = candidate
        break
      }
    } catch {}
  }
  const nativeOperation = STORAGE_NATIVE_BY_OPERATION_V1[context.operation as StorageOperationV1]
  if (selection == null || nativeOperation == null || !installation.operations.includes(nativeOperation)) {
    throw new CapabilityInvocationError('capability.denied', context.operation)
  }
  if (resource.kind === 'storageKv') {
    const name = context.operation === 'storage.kv.list' ? input.prefix : input.key
    if (typeof name !== 'string' || !selection.keyPrefixes.some(prefix => name.startsWith(prefix))) {
      throw new CapabilityInvocationError('capability.denied', context.operation)
    }
  } else if (
    typeof input.database !== 'string' || resource.database !== input.database ||
    !selection.databases.includes(input.database)
  ) throw new CapabilityInvocationError('capability.denied', context.operation)
  const limits = Object.fromEntries(
    Object.entries(selection.limits).map(([key, value]) => [
      key,
      Math.min(value, installation.limits?.[key as StorageLimitNameV2] ?? value)
    ])
  ) as StorageLimitsV2
  return { nativeOperation, selection: { ...selection, limits } }
}

/** Consume only the original copied bytes and bind them to the selected Broker authority. */
export const storageCommandV1 = (
  context: HoloInvocationContextV1,
  authority: CapabilityProviderAuthorityV1,
  installation: StorageHostInstallationV1,
  binary: readonly StorageBinaryV1[],
  token: string
) => {
  try {
    const { nativeOperation, selection } = selected(context, authority, installation)
    const input = context.arguments as StorageArgumentsV1
    if (
      nativeOperation === 'v1.kv.set' &&
      (binary.length !== 1 || binary[0].handle !== 'value' ||
        binary[0].data.byteLength !== input.valueByteLength ||
        sha256Hex(binary[0].data) !== input.valueSha256 ||
        binary[0].data.byteLength > selection.limits.maxValueBytes)
    ) throw new CapabilityInvocationError('argument.invalid', context.operation)
    if (nativeOperation !== 'v1.kv.set' && binary.length !== 0) {
      throw new CapabilityInvocationError('argument.invalid', context.operation)
    }
    const { namespaceId: _namespaceId, valueByteLength: _length, valueSha256: _sha, ...args } = input
    const command = JSON.stringify({
      operation: nativeOperation,
      args,
      binary: binary.map(item => ({ handle: item.handle, base64: encodeBase64(item.data, false) })),
      selection,
      ...(nativeOperation === 'v1.kv.set'
        ? { valueByteLength: input.valueByteLength, valueSha256: input.valueSha256 }
        : {}),
      callToken: token
    })
    return { command, nativeOperation }
  } finally {
    for (const item of binary) item.data.fill(0)
  }
}
