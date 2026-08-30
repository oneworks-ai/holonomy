import type {
  CapabilityMiddlewareExecutionV1,
  HoloInvocationContextV1,
  HoloInvocationMatcherV1,
  HoloMiddlewareV1
} from '@holonomyjs/runtime/kernel/broker-types'
import type { DisposableV1 } from '@holonomyjs/runtime/kernel/interceptor-registry'

export type HoloPermissionDecisionV1 = 'allow' | 'deny'

export interface HoloPermissionDecisionContextV1 {
  readonly invocation: HoloInvocationContextV1
  readonly pluginConfig: unknown
}

export type HoloPermissionDeciderV1 = (
  context: HoloPermissionDecisionContextV1
) => HoloPermissionDecisionV1 | Promise<HoloPermissionDecisionV1>

export interface HoloPermissionPluginOptionsV1 {
  readonly decide: HoloPermissionDeciderV1
  readonly execution?: CapabilityMiddlewareExecutionV1
  readonly matcher?: HoloInvocationMatcherV1
  readonly timeoutMs?: number
}

interface HoloPermissionPluginContextV1 {
  readonly holo: Readonly<{
    deny(invocation: HoloInvocationContextV1): never
    intercept(
      matcher: HoloInvocationMatcherV1,
      middleware: HoloMiddlewareV1,
      options?: Readonly<{ execution?: CapabilityMiddlewareExecutionV1; timeoutMs?: number }>
    ): DisposableV1
  }>
}

export const createHoloPermissionPluginV1 = (options: HoloPermissionPluginOptionsV1) => {
  if (typeof options?.decide !== 'function') throw new TypeError('Permission decider is required')
  return (context: HoloPermissionPluginContextV1, pluginConfig: unknown): void => {
    const decide = (invocation: HoloInvocationContextV1) => options.decide(Object.freeze({ invocation, pluginConfig }))
    const middleware: HoloMiddlewareV1 = options.execution === 'sync'
      ? (invocation, next) => {
        const decision = decide(invocation)
        if (decision instanceof Promise) throw new TypeError('Sync permission decider returned a Promise')
        if (decision === 'deny') return context.holo.deny(invocation)
        if (decision !== 'allow') throw new TypeError('Permission decision must be allow or deny')
        return next()
      }
      : async (invocation, next) => {
        const decision = await decide(invocation)
        if (decision === 'deny') return context.holo.deny(invocation)
        if (decision !== 'allow') throw new TypeError('Permission decision must be allow or deny')
        return await next()
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
