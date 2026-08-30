import { invokeCapabilityProviderAsyncV1, invokeCapabilityProviderSyncV1 } from './broker-provider-invocation.js'
import type { CapabilityProviderResolutionAdmitterV1 } from './broker-resolution-types.js'
import type {
  CapabilityBrokerProviderV1,
  CapabilityProviderAuthorityV1,
  CapabilityProviderTerminalV1,
  HoloInvocationContextV1,
  HoloMiddlewareRegistrationV1
} from './broker-types.js'
import { isTrustedInvocationValueV1 } from './broker-values.js'
import type { TrustedInvocationValueV1 } from './broker-values.js'
import { CapabilityInvocationError, capabilityFailure } from './errors.js'

interface ExecutionInputV1<THostContext> {
  readonly abort: (reason: CapabilityInvocationError) => void
  readonly authority: CapabilityProviderAuthorityV1
  readonly context: HoloInvocationContextV1<THostContext>
  readonly middleware: readonly HoloMiddlewareRegistrationV1<THostContext>[]
  readonly ownsTerminal: (terminal: CapabilityProviderTerminalV1) => boolean
  readonly provider: CapabilityBrokerProviderV1<THostContext>
  readonly providerTimeoutMs: number
  readonly resolution: CapabilityProviderResolutionAdmitterV1<THostContext>
}

const fail = <T>(input: ExecutionInputV1<T>, code: Parameters<typeof capabilityFailure>[0]): never =>
  capabilityFailure(code, input.context.operation, input.context.resource.requested.semanticResourceDigest)

const abortFailure = <T>(input: ExecutionInputV1<T>): never => {
  const reason = input.context.signal.reason
  if (reason instanceof CapabilityInvocationError) throw reason
  return fail(input, 'runtime.cancelled')
}

const providerResult = <T>(
  input: ExecutionInputV1<T>,
  terminal: CapabilityProviderTerminalV1
): TrustedInvocationValueV1 => {
  if (!input.ownsTerminal(terminal)) return fail(input, 'provider.protocol_error')
  return terminal.result
}

const syncProvider = <T>(input: ExecutionInputV1<T>): TrustedInvocationValueV1 => {
  if (input.provider.execution !== 'sync') return fail(input, 'runtime.async_required')
  let terminal: CapabilityProviderTerminalV1 | Promise<CapabilityProviderTerminalV1>
  try {
    terminal = invokeCapabilityProviderSyncV1(input)
  } catch (error) {
    if (error instanceof CapabilityInvocationError) throw error
    return fail(input, 'provider.unavailable')
  }
  if (terminal instanceof Promise) return fail(input, 'runtime.async_required')
  return providerResult(input, terminal)
}

export const executeCapabilitySyncV1 = <THostContext>(
  input: ExecutionInputV1<THostContext>
): TrustedInvocationValueV1 => {
  if (input.middleware.some(item => item.execution !== 'sync')) return fail(input, 'runtime.async_required')
  const dispatch = (index: number): TrustedInvocationValueV1 => {
    const registration = input.middleware[index]
    if (registration == null) return syncProvider(input)
    let called = false
    const next = () => {
      if (called) return fail(input, 'middleware.failed')
      called = true
      return dispatch(index + 1)
    }
    let value: TrustedInvocationValueV1 | Promise<TrustedInvocationValueV1>
    try {
      value = registration.middleware(input.context, next)
    } catch (error) {
      if (error instanceof CapabilityInvocationError) throw error
      return fail(input, 'middleware.failed')
    }
    if (value instanceof Promise) return fail(input, 'runtime.async_required')
    if (!isTrustedInvocationValueV1(value, 'result')) return fail(input, 'middleware.invalid_result')
    return value
  }
  return dispatch(0)
}

const race = async <T, THostContext>(
  input: ExecutionInputV1<THostContext>,
  promise: Promise<T>,
  timeoutCode: 'middleware.timeout' | 'provider.timeout',
  timeoutMs?: number
): Promise<T> => {
  if (input.context.signal.aborted) return abortFailure(input)
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const terminal = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(
        input.context.signal.reason instanceof CapabilityInvocationError
          ? input.context.signal.reason
          : new CapabilityInvocationError(
            'runtime.cancelled',
            input.context.operation,
            input.context.resource.requested.semanticResourceDigest
          )
      )
    input.context.signal.addEventListener('abort', abort, { once: true })
    if (timeoutMs != null) {
      timeout = setTimeout(() => {
        const error = new CapabilityInvocationError(
          timeoutCode,
          input.context.operation,
          input.context.resource.requested.semanticResourceDigest
        )
        input.abort(error)
        reject(error)
      }, timeoutMs)
    }
  })
  try {
    return await Promise.race([promise, terminal])
  } finally {
    if (timeout != null) clearTimeout(timeout)
    if (abort != null) input.context.signal.removeEventListener('abort', abort)
  }
}

const asyncProvider = async <T>(input: ExecutionInputV1<T>): Promise<TrustedInvocationValueV1> => {
  try {
    if (input.context.signal.aborted) return abortFailure(input)
    const invocation = invokeCapabilityProviderAsyncV1(input)
    const terminal = await race(
      input,
      Promise.resolve(invocation),
      'provider.timeout',
      input.providerTimeoutMs
    )
    if (input.context.signal.aborted) return abortFailure(input)
    return providerResult(input, terminal)
  } catch (error) {
    if (error instanceof CapabilityInvocationError) throw error
    return fail(input, 'provider.unavailable')
  }
}

export const executeCapabilityAsyncV1 = async <THostContext>(
  input: ExecutionInputV1<THostContext>
): Promise<TrustedInvocationValueV1> => {
  const dispatch = async (index: number): Promise<TrustedInvocationValueV1> => {
    if (input.context.signal.aborted) return abortFailure(input)
    const registration = input.middleware[index]
    if (registration == null) return await asyncProvider(input)
    let called = false
    const next = async () => {
      if (called) return fail(input, 'middleware.failed')
      called = true
      return await dispatch(index + 1)
    }
    try {
      const value = await race(
        input,
        Promise.resolve(registration.middleware(input.context, next)),
        'middleware.timeout',
        registration.timeoutMs
      )
      if (!isTrustedInvocationValueV1(value, 'result')) return fail(input, 'middleware.invalid_result')
      return value
    } catch (error) {
      if (error instanceof CapabilityInvocationError) throw error
      return fail(input, 'middleware.failed')
    }
  }
  return await dispatch(0)
}
