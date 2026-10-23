import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel/errors'
import { decodeBase64 } from '@holonomyjs/runtime/node-compat/encoding'
import { mapStorageKernelErrorV1 } from '../kernel/storage-error-mapping.js'
import { STORAGE_OPERATION_BY_NATIVE_V1, createStorageInvocationV1 } from '../kernel/storage-invocation.js'
import { STORAGE_LIMIT_MAXIMA_V2 } from '../kernel/storage-policy.js'
import { storageHostLimitsV1 } from './limits.js'
import { storageDispatchSuccessV1, storageFailureV1 as failure } from './terminal.js'
import type {
  StorageArgumentsV1,
  StorageHostInstallationV1,
  StorageHostPolicyV1,
  StorageHostProviderV1,
  StorageHostStateV1,
  StorageTrackedKernelV1
} from './types.js'

interface KernelTerminalV1 {
  readonly ok?: boolean
  readonly error?: unknown
  readonly value?: unknown
}

export const createStorageDispatchV1 = (
  state: StorageHostStateV1,
  installation: StorageHostInstallationV1,
  policy: StorageHostPolicyV1
): StorageHostProviderV1['dispatch'] => {
  const limits = storageHostLimitsV1(installation)
  const pendingCap = policy.access === 'sandboxed'
    ? Math.min(
      policy.limits.maxPendingOperations,
      installation.limits?.maxPendingOperations ?? STORAGE_LIMIT_MAXIMA_V2.maxPendingOperations
    )
    : Infinity
  return async (request, token, signal, kernel) => {
    if (state.closed || signal.aborted) return failure('storage.cancelled')
    if (!Object.hasOwn(STORAGE_OPERATION_BY_NATIVE_V1, request.operation)) return failure('storage.invalid_argument')
    if (!installation.operations.includes(request.operation)) return failure('storage.authorization_denied')
    if (state.occupied >= pendingCap) return failure('storage.limit_exceeded')
    state.occupied += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      state.occupied -= 1
    }
    const forget = () => {
      const pending = state.payloads.get(token)
      if (pending != null) { for (const item of pending) item.data.fill(0) }
      state.payloads.delete(token)
    }
    signal.addEventListener('abort', forget, { once: true })
    let tracked: ReturnType<StorageTrackedKernelV1['invokeTracked']> | undefined
    try {
      const invocation = createStorageInvocationV1(request, 'default', token)
      const args = (JSON.parse(invocation) as { arguments: StorageArgumentsV1 }).arguments
      if (!limits.allowsArguments(request.operation, args)) return failure('storage.limit_exceeded')
      const binary = (request.binary ?? []).map(item => ({
        handle: item.handle,
        data: new Uint8Array(decodeBase64(item.base64))
      }))
      if (state.payloads.has(token)) return failure('storage.protocol_error')
      state.payloads.set(token, binary)
      tracked = kernel.invokeTracked(invocation, signal)
      void Promise.resolve(tracked.settled).then(release, release)
      const result = JSON.parse(await tracked.result) as KernelTerminalV1
      if (signal.aborted || state.closed) return failure('storage.cancelled')
      if (result.ok !== true) return failure(mapStorageKernelErrorV1(result.error))
      const valueError = (result.value as { error?: { code: string } } | null)?.error
      if (valueError != null) return failure(valueError.code)
      if (!limits.allowsResult(request.operation, result.value)) return failure('storage.limit_exceeded')
      return storageDispatchSuccessV1(request.operation, result.value)
    } catch (error) {
      if (signal.aborted || state.closed) return failure('storage.cancelled')
      return failure(
        error instanceof CapabilityInvocationError && error.code === 'argument.invalid'
          ? 'storage.invalid_argument'
          : 'storage.internal'
      )
    } finally {
      signal.removeEventListener('abort', forget)
      forget()
      if (tracked == null) release()
    }
  }
}
