/* eslint-disable max-lines -- synchronous and asynchronous Broker frames share terminal and settlement invariants. */
import type { BrokerFrameLeaseV1 } from './broker-frame-lease.js'
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

const syncProvider = <T>(input: ExecutionInputV1<T>, lease: BrokerFrameLeaseV1): TrustedInvocationValueV1 => {
  if (input.provider.execution !== 'sync') return fail(input, 'runtime.async_required')
  let terminal: CapabilityProviderTerminalV1 | Promise<CapabilityProviderTerminalV1>
  try {
    terminal = invokeCapabilityProviderSyncV1(input, (task, terminalResult) => {
      const observed = terminalResult
        ? task.then(value => {
          input.ownsTerminal(value as CapabilityProviderTerminalV1)
          return value
        })
        : task
      lease.track(observed)
    })
  } catch (error) {
    if (error instanceof CapabilityInvocationError) throw error
    return fail(input, 'provider.unavailable')
  }
  if (terminal instanceof Promise) {
    void lease.track(terminal).then(value => input.ownsTerminal(value), () => undefined).catch(() => undefined)
    return fail(input, 'runtime.async_required')
  }
  return providerResult(input, terminal)
}

export const executeCapabilitySyncV1 = <THostContext>(
  input: ExecutionInputV1<THostContext>,
  lease: BrokerFrameLeaseV1
): TrustedInvocationValueV1 => {
  if (input.middleware.some(item => item.execution !== 'sync')) return fail(input, 'runtime.async_required')
  const dispatch = (index: number): TrustedInvocationValueV1 => {
    const registration = input.middleware[index]
    if (registration == null) return syncProvider(input, lease)
    let called = false
    let violation: CapabilityInvocationError | undefined
    const next = () => {
      if (called) {
        violation ??= new CapabilityInvocationError(
          'middleware.failed',
          input.context.operation,
          input.context.resource.requested.semanticResourceDigest
        )
        throw violation
      }
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
    if (violation != null) throw violation
    if (value instanceof Promise) {
      lease.track(value)
      return fail(input, 'runtime.async_required')
    }
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
    if (input.context.signal.aborted) abort()
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

const asyncProvider = async <T>(
  input: ExecutionInputV1<T>,
  lease: BrokerFrameLeaseV1
): Promise<TrustedInvocationValueV1> => {
  try {
    if (input.context.signal.aborted) return abortFailure(input)
    // Host task checkpoint: all same-turn middleware Promise reactions finish
    // before actual I/O starts. Already started Provider work cannot be rolled back.
    const invocation = lease.track(new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => {
      if (lease.closed || input.context.signal.aborted) return abortFailure(input)
      return invokeCapabilityProviderAsyncV1(input)
    }))
    void invocation.then(terminal => input.ownsTerminal(terminal), () => undefined).catch(() => undefined)
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
  input: ExecutionInputV1<THostContext>,
  lease: BrokerFrameLeaseV1
): Promise<TrustedInvocationValueV1> => {
  let poisoned: CapabilityInvocationError | undefined
  const poison = () => {
    poisoned ??= new CapabilityInvocationError(
      'middleware.failed',
      input.context.operation,
      input.context.resource.requested.semanticResourceDigest
    )
    input.abort(poisoned)
    return poisoned
  }
  const dispatch = async (index: number): Promise<TrustedInvocationValueV1> => {
    if (lease.closed || input.context.signal.aborted) return abortFailure(input)
    const registration = input.middleware[index]
    if (registration == null) return await asyncProvider(input, lease)
    let called = false
    let frameClosed = false
    const next = () => {
      if (called || frameClosed || lease.closed) {
        const rejected = Promise.reject(poison()) as Promise<TrustedInvocationValueV1>
        void rejected.catch(() => undefined)
        return rejected
      }
      called = true
      const child = start(index + 1)
      void child.catch(() => undefined)
      return child
    }
    try {
      const raw = lease.track(Promise.resolve(registration.middleware(input.context, next)))
      const value = await race(
        input,
        raw,
        'middleware.timeout',
        registration.timeoutMs
      )
      if (poisoned != null) throw poisoned
      if (!isTrustedInvocationValueV1(value, 'result')) return fail(input, 'middleware.invalid_result')
      return value
    } catch (error) {
      const terminal = error instanceof CapabilityInvocationError
        ? error
        : new CapabilityInvocationError(
          'middleware.failed',
          input.context.operation,
          input.context.resource.requested.semanticResourceDigest
        )
      input.abort(terminal)
      throw terminal
    } finally {
      frameClosed = true
    }
  }
  const start = (index: number): Promise<TrustedInvocationValueV1> =>
    lease.track(Promise.resolve().then(() => dispatch(index)))
  return await start(0)
}
