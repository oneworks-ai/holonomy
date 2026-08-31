import type {
  CapabilityMiddlewareExecutionV1,
  HoloInvocationContextV1,
  HoloInvocationMatcherV1,
  HoloMiddlewareV1
} from '@holonomyjs/runtime/kernel/broker-types'
import type { TrustedInvocationValueV1 } from '@holonomyjs/runtime/kernel/broker-values'
import type { DisposableV1 } from '@holonomyjs/runtime/kernel/interceptor-registry'

export type HoloAuditEventV1 = Readonly<{
  readonly invocation: HoloInvocationContextV1
  readonly phase: 'failed' | 'succeeded'
  readonly pluginConfig: unknown
  readonly error?: unknown
  readonly result?: TrustedInvocationValueV1
}>

export type HoloAuditSinkV1 = (event: HoloAuditEventV1) => void | Promise<void>

export interface HoloAuditPluginOptionsV1 {
  readonly execution?: CapabilityMiddlewareExecutionV1
  readonly matcher?: HoloInvocationMatcherV1
  readonly sink: HoloAuditSinkV1
  readonly timeoutMs?: number
}

interface HoloAuditPluginContextV1 {
  readonly holo: Readonly<{
    intercept(
      matcher: HoloInvocationMatcherV1,
      middleware: HoloMiddlewareV1,
      options?: Readonly<{ execution?: CapabilityMiddlewareExecutionV1; timeoutMs?: number }>
    ): DisposableV1
  }>
}

export const createHoloAuditPluginV1 = (options: HoloAuditPluginOptionsV1) => {
  if (typeof options?.sink !== 'function') throw new TypeError('Audit sink is required')
  return (context: HoloAuditPluginContextV1, pluginConfig: unknown): void => {
    const middleware: HoloMiddlewareV1 = options.execution === 'sync'
      ? (invocation, next) => {
        let result: TrustedInvocationValueV1
        try {
          const value = next()
          if (value instanceof Promise) throw new TypeError('Sync audit middleware received a Promise result')
          result = value
        } catch (error) {
          const settled = options.sink(Object.freeze({ error, invocation, phase: 'failed', pluginConfig }))
          if (settled instanceof Promise) throw new TypeError('Sync audit sink returned a Promise')
          throw error
        }
        const settled = options.sink(Object.freeze({ invocation, phase: 'succeeded', pluginConfig, result }))
        if (settled instanceof Promise) throw new TypeError('Sync audit sink returned a Promise')
        return result
      }
      : async (invocation, next) => {
        try {
          const result = await next()
          await options.sink(Object.freeze({ invocation, phase: 'succeeded', pluginConfig, result }))
          return result
        } catch (error) {
          await options.sink(Object.freeze({ error, invocation, phase: 'failed', pluginConfig }))
          throw error
        }
      }
    context.holo.intercept(
      options.matcher ?? {},
      middleware,
      {
        execution: options.execution ?? 'async',
        ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs })
      }
    )
  }
}
