import { capabilityProviderContextV1 } from './broker-host-bindings.js'
import type {
  AdmittedProviderResolutionV1,
  CapabilityProviderResolutionAdmitterV1,
  CapabilityProviderResolutionPlanV1
} from './broker-resolution-types.js'
import type {
  CapabilityBrokerProviderV1,
  CapabilityProviderAuthorityV1,
  CapabilityProviderTerminalV1,
  HoloInvocationContextV1
} from './broker-types.js'
import { capabilityFailure } from './errors.js'

interface ProviderInvocationInputV1<THostContext> {
  readonly authority: CapabilityProviderAuthorityV1
  readonly context: HoloInvocationContextV1<THostContext>
  readonly provider: CapabilityBrokerProviderV1<THostContext>
  readonly resolution: CapabilityProviderResolutionAdmitterV1<THostContext>
}

const fail = <T>(
  input: ProviderInvocationInputV1<T>,
  code: 'provider.protocol_error' | 'runtime.async_required'
): never =>
  capabilityFailure(
    code,
    input.context.operation,
    input.context.resource.requested.semanticResourceDigest
  )

const requests = <T>(
  input: ProviderInvocationInputV1<T>,
  plan: CapabilityProviderResolutionPlanV1<T>
) => {
  if (!Array.isArray(plan.requests) || plan.requests.length < 1 || plan.requests.length > 32) {
    return fail(input, 'provider.protocol_error')
  }
  return plan.requests
}

const disposeSync = <T>(
  input: ProviderInvocationInputV1<T>,
  plan: CapabilityProviderResolutionPlanV1<T>,
  observeLate?: (task: Promise<unknown>, terminal: boolean) => void
) => {
  const value = plan.dispose?.()
  if (value instanceof Promise) {
    observeLate?.(value, false)
    return fail(input, 'runtime.async_required')
  }
}

export const invokeCapabilityProviderSyncV1 = <THostContext>(
  input: ProviderInvocationInputV1<THostContext>,
  observeLate?: (task: Promise<unknown>, terminal: boolean) => void
): CapabilityProviderTerminalV1 => {
  const context = capabilityProviderContextV1(input.context)
  const candidate = input.provider.preflight?.(context, input.authority)
  if (candidate instanceof Promise) {
    observeLate?.(candidate, false)
    return fail(input, 'runtime.async_required')
  }
  if (candidate == null) {
    const terminal = input.provider.invoke(context, input.authority)
    if (terminal instanceof Promise) {
      observeLate?.(terminal, true)
      return fail(input, 'runtime.async_required')
    }
    return terminal
  }
  const plan = candidate
  const admitted: AdmittedProviderResolutionV1<THostContext>[] = []
  try {
    for (const request of requests(input, plan)) admitted.push(input.resolution.admitSync(request))
    for (let index = 0; index < admitted.length; index += 1) {
      const evidence = plan.requests[index]!.verify()
      if (evidence instanceof Promise) {
        observeLate?.(evidence, false)
        return fail(input, 'runtime.async_required')
      }
      admitted[index]!.consume(evidence)
    }
    const terminal = plan.execute(
      capabilityProviderContextV1(admitted[0]!.context),
      admitted.map(item => item.authority),
      admitted.map(item => item.token)
    )
    if (terminal instanceof Promise) {
      observeLate?.(terminal, true)
      return fail(input, 'runtime.async_required')
    }
    return terminal
  } finally {
    try {
      for (const item of admitted) item.dispose()
    } finally {
      disposeSync(input, plan, observeLate)
    }
  }
}

export const invokeCapabilityProviderAsyncV1 = async <THostContext>(
  input: ProviderInvocationInputV1<THostContext>
): Promise<CapabilityProviderTerminalV1> => {
  const context = capabilityProviderContextV1(input.context)
  const plan = await input.provider.preflight?.(context, input.authority)
  if (plan == null) return await input.provider.invoke(context, input.authority)
  const admitted: AdmittedProviderResolutionV1<THostContext>[] = []
  try {
    for (const request of requests(input, plan)) admitted.push(await input.resolution.admit(request))
    for (let index = 0; index < admitted.length; index += 1) {
      admitted[index]!.consume(await plan.requests[index]!.verify())
    }
    return await plan.execute(
      capabilityProviderContextV1(admitted[0]!.context),
      admitted.map(item => item.authority),
      admitted.map(item => item.token)
    )
  } finally {
    try {
      for (const item of admitted) item.dispose()
    } finally {
      await plan.dispose?.()
    }
  }
}
