import { compileInitialMiddlewareSetV1 } from './broker-matcher.js'
import type {
  CapabilityMiddlewareExecutionV1,
  HoloInvocationMatcherV1,
  HoloMiddlewareRegistrationV1,
  HoloMiddlewareV1
} from './broker-types.js'

export interface DisposableV1 {
  dispose(): void
}

export class RuntimeInterceptorRegistryV1<THostContext> {
  #next = 0
  readonly #registrations = new Map<string, HoloMiddlewareRegistrationV1<THostContext>>()

  snapshot(): readonly HoloMiddlewareRegistrationV1<THostContext>[] {
    return Object.freeze([...this.#registrations.values()])
  }

  use(
    matcher: HoloInvocationMatcherV1,
    middleware: HoloMiddlewareV1<THostContext>,
    options: Readonly<{
      execution?: CapabilityMiddlewareExecutionV1
      timeoutMs?: number
    }> = {}
  ): DisposableV1 {
    const registrationId = `live-${++this.#next}`
    const registration = compileInitialMiddlewareSetV1<THostContext>({
      registrations: [{
        execution: options.execution ?? 'async',
        layer: 'application',
        matcher,
        middleware,
        registrationId,
        ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs })
      }],
      schemaVersion: 1
    }).registrations[0]!
    this.#registrations.set(registrationId, registration)
    let disposed = false
    return Object.freeze({
      dispose: () => {
        if (disposed) return
        disposed = true
        this.#registrations.delete(registrationId)
      }
    })
  }
}
