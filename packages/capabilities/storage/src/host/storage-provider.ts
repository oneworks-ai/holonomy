import type { CapabilityBrokerProviderV1 } from '@holonomyjs/runtime/kernel/broker-types'
import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel/errors'
import { trustedInvocationValueFromJsonV1 } from '@holonomyjs/runtime/kernel/json-invocation-value'
import { storageCommandV1 } from './admission.js'
import { createStorageDispatchV1 } from './dispatch.js'
import { storageNativeResultV1 } from './terminal.js'
import type {
  StorageHostInstallationV1,
  StorageHostPolicyV1,
  StorageHostProviderV1,
  StorageHostStateV1,
  StorageNativePortV1
} from './types.js'

/** One Host-only payload table and asynchronous native-job lifecycle for every platform. */
export const createHostStorageProvider = (
  native: StorageNativePortV1,
  installation: StorageHostInstallationV1,
  policy: StorageHostPolicyV1
): StorageHostProviderV1 => {
  const state: StorageHostStateV1 = { payloads: new Map(), active: new Set(), occupied: 0, closed: false }
  const invoke: CapabilityBrokerProviderV1['invoke'] = async (context, authority) => {
    if (state.closed || context.signal.aborted) {
      throw new CapabilityInvocationError('runtime.cancelled', context.operation)
    }
    const token = (context.providerData as { storageCallToken?: unknown } | undefined)?.storageCallToken
    if (typeof token !== 'string' || !state.payloads.has(token)) {
      throw new CapabilityInvocationError('provider.protocol_error', context.operation)
    }
    const binary = state.payloads.get(token)!
    state.payloads.delete(token)
    const { command, nativeOperation } = storageCommandV1(context, authority, installation, binary, token)
    let started: ReturnType<StorageNativePortV1['storageStart']>
    try {
      started = native.storageStart(command)
    } catch (error) {
      const candidate = (error as { code?: unknown } | null)?.code
      const code = typeof candidate === 'string' && /^storage\.[a-z_]+$/u.test(candidate)
        ? candidate
        : 'storage.internal'
      return authority.complete(trustedInvocationValueFromJsonV1({ error: { code } }, 'result'))
    }
    state.active.add(started.id)
    const abort = () => {
      try {
        native.storageCancel(started.id)
      } catch {}
    }
    context.signal.addEventListener('abort', abort, { once: true })
    if (context.signal.aborted) abort()
    try {
      const output = await started.promise
      if (context.signal.aborted || state.closed) {
        throw new CapabilityInvocationError('runtime.cancelled', context.operation)
      }
      const value = storageNativeResultV1(output, nativeOperation, context.operation)
      return authority.complete(trustedInvocationValueFromJsonV1(value, 'result'))
    } catch (error) {
      if (error instanceof CapabilityInvocationError) throw error
      throw new CapabilityInvocationError('provider.protocol_error', context.operation)
    } finally {
      state.active.delete(started.id)
      context.signal.removeEventListener('abort', abort)
    }
  }
  return {
    provider: { execution: 'async', module: 'host.storage', invoke },
    dispatch: createStorageDispatchV1(state, installation, policy),
    close() {
      state.closed = true
      for (const id of state.active) {
        try {
          native.storageCancel(id)
        } catch {}
      }
      for (const binary of state.payloads.values()) for (const item of binary) item.data.fill(0)
      state.payloads.clear()
      state.active.clear()
    }
  }
}

/** Existing Desktop name remains an identical function, without another lifecycle owner. */
export const createNativeStorageProvider = createHostStorageProvider
export type {
  StorageDispatchRequestV1,
  StorageDispatchTerminalV1,
  StorageHostInstallationV1,
  StorageHostPolicyV1,
  StorageHostProviderV1,
  StorageNativePortV1,
  StorageTrackedKernelV1
} from './types.js'
