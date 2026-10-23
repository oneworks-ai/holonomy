import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel/errors'
import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import type { StorageDispatchTerminalV1 } from './types.js'

export const storageFailureV1 = (code: string): StorageDispatchTerminalV1 => ({
  value: { ok: false, error: { code } }
})

const success = (value: unknown, binary?: StorageDispatchTerminalV1['binary']): StorageDispatchTerminalV1 => ({
  value: { ok: true, value },
  ...(binary == null ? {} : { binary })
})

interface NativeTerminalV1 {
  readonly value?: { ok?: boolean; error?: unknown; value?: unknown }
  readonly binary?: readonly { handle: string; base64: string }[]
}

/** The Broker owns operation result schema validation after native envelope conversion. */
export const storageNativeResultV1 = (json: string, nativeOperation: string, operation: string): JsonValueV1 => {
  const output = JSON.parse(json) as NativeTerminalV1
  const envelope = output.value
  if (envelope?.ok === false) return { error: envelope.error } as JsonValueV1
  if (envelope?.ok !== true) throw new CapabilityInvocationError('provider.protocol_error', operation)
  const value = nativeOperation !== 'v1.kv.get'
    ? envelope.value
    : envelope.value === null
    ? { found: false }
    : envelope.value === true && output.binary?.length === 1 && output.binary[0]?.handle === 'value'
    ? { found: true, valueBase64: output.binary[0].base64 }
    : undefined
  if (value === undefined) throw new CapabilityInvocationError('provider.protocol_error', operation)
  return value as JsonValueV1
}

export const storageDispatchSuccessV1 = (operation: string, value: unknown): StorageDispatchTerminalV1 => {
  if (operation !== 'v1.kv.get') return success(value)
  const result = value as { found?: boolean; valueBase64?: unknown } | null
  if (result?.found === false) return success(null)
  if (result?.found !== true || typeof result.valueBase64 !== 'string') {
    return storageFailureV1('storage.protocol_error')
  }
  return success(true, [{ handle: 'value', base64: result.valueBase64 }])
}
