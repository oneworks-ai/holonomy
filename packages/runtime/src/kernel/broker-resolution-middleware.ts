import type { HoloInvocationContextV1, HoloMiddlewareRegistrationV1 } from './broker-types.js'
import { isTrustedInvocationValueV1 } from './broker-values.js'
import { CapabilityInvocationError, capabilityFailure } from './errors.js'
import { trustedInvocationValueFromJsonV1 } from './json-invocation-value.js'

const marker = () => trustedInvocationValueFromJsonV1({}, 'result')

const abortFailure = <T>(context: HoloInvocationContextV1<T>): never => {
  if (context.signal.reason instanceof CapabilityInvocationError) throw context.signal.reason
  return capabilityFailure(
    'runtime.cancelled',
    context.operation,
    context.resource.requested.semanticResourceDigest
  )
}

const fail = <T>(context: HoloInvocationContextV1<T>, code: 'middleware.failed' | 'middleware.invalid_result'): never =>
  capabilityFailure(code, context.operation, context.resource.requested.semanticResourceDigest)

export const runResolutionMiddlewareSyncV1 = <THostContext>(
  context: HoloInvocationContextV1<THostContext>,
  middleware: readonly HoloMiddlewareRegistrationV1<THostContext>[]
): void => {
  if (context.signal.aborted) return abortFailure(context)
  if (middleware.some(item => item.execution !== 'sync')) {
    return capabilityFailure(
      'runtime.async_required',
      context.operation,
      context.resource.requested.semanticResourceDigest
    )
  }
  const dispatch = (index: number): ReturnType<typeof marker> => {
    const registration = middleware[index]
    if (registration == null) return marker()
    let called = false
    const next = () => {
      if (called) return fail(context, 'middleware.failed')
      called = true
      return dispatch(index + 1)
    }
    let value: ReturnType<typeof marker> | Promise<ReturnType<typeof marker>>
    try {
      value = registration.middleware(context, next)
    } catch (error) {
      if (error instanceof CapabilityInvocationError) throw error
      return fail(context, 'middleware.failed')
    }
    if (value instanceof Promise) {
      return capabilityFailure(
        'runtime.async_required',
        context.operation,
        context.resource.requested.semanticResourceDigest
      )
    }
    if (!isTrustedInvocationValueV1(value, 'result')) return fail(context, 'middleware.invalid_result')
    return value
  }
  dispatch(0)
}

const withDeadline = async <T, THostContext>(
  context: HoloInvocationContextV1<THostContext>,
  promise: Promise<T>,
  timeoutMs?: number
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const terminal = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(
        context.signal.reason instanceof CapabilityInvocationError
          ? context.signal.reason
          : new CapabilityInvocationError(
            'runtime.cancelled',
            context.operation,
            context.resource.requested.semanticResourceDigest
          )
      )
    context.signal.addEventListener('abort', abort, { once: true })
    if (timeoutMs != null) {
      timeout = setTimeout(() =>
        reject(
          new CapabilityInvocationError(
            'middleware.timeout',
            context.operation,
            context.resource.requested.semanticResourceDigest
          )
        ), timeoutMs)
    }
  })
  try {
    return await Promise.race([promise, terminal])
  } finally {
    if (timeout != null) clearTimeout(timeout)
    if (abort != null) context.signal.removeEventListener('abort', abort)
  }
}

export const runResolutionMiddlewareAsyncV1 = async <THostContext>(
  context: HoloInvocationContextV1<THostContext>,
  middleware: readonly HoloMiddlewareRegistrationV1<THostContext>[]
): Promise<void> => {
  const dispatch = async (index: number): Promise<ReturnType<typeof marker>> => {
    if (context.signal.aborted) return abortFailure(context)
    const registration = middleware[index]
    if (registration == null) return marker()
    let called = false
    const next = async () => {
      if (called) return fail(context, 'middleware.failed')
      called = true
      return await dispatch(index + 1)
    }
    try {
      const value = await withDeadline(
        context,
        Promise.resolve(registration.middleware(context, next)),
        registration.timeoutMs
      )
      if (!isTrustedInvocationValueV1(value, 'result')) return fail(context, 'middleware.invalid_result')
      return value
    } catch (error) {
      if (error instanceof CapabilityInvocationError) throw error
      return fail(context, 'middleware.failed')
    }
  }
  await dispatch(0)
}
