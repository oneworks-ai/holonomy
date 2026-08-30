import type {
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

const disposeSync = <T>(input: ProviderInvocationInputV1<T>, plan: CapabilityProviderResolutionPlanV1<T>) => {
  const value = plan.dispose?.()
  if (value instanceof Promise) return fail(input, 'runtime.async_required')
}

export const invokeCapabilityProviderSyncV1 = <THostContext>(
  input: ProviderInvocationInputV1<THostContext>
): CapabilityProviderTerminalV1 => {
  const candidate = input.provider.preflight?.(input.context, input.authority)
  if (candidate instanceof Promise) return fail(input, 'runtime.async_required')
  if (candidate == null) {
    const terminal = input.provider.invoke(input.context, input.authority)
    if (terminal instanceof Promise) return fail(input, 'runtime.async_required')
    return terminal
  }
  const plan = candidate
  const admitted = requests(input, plan).map(request => input.resolution.admitSync(request))
  try {
    for (let index = 0; index < admitted.length; index += 1) {
      const evidence = plan.requests[index]!.verify()
      if (evidence instanceof Promise) return fail(input, 'runtime.async_required')
      admitted[index]!.consume(evidence)
    }
    const terminal = plan.execute(
      admitted[0]!.context,
      admitted.map(item => item.authority),
      admitted.map(item => item.token)
    )
    if (terminal instanceof Promise) return fail(input, 'runtime.async_required')
    return terminal
  } finally {
    for (const item of admitted) item.dispose()
    disposeSync(input, plan)
  }
}

export const invokeCapabilityProviderAsyncV1 = async <THostContext>(
  input: ProviderInvocationInputV1<THostContext>
): Promise<CapabilityProviderTerminalV1> => {
  const plan = await input.provider.preflight?.(input.context, input.authority)
  if (plan == null) return await input.provider.invoke(input.context, input.authority)
  const admitted = []
  for (const request of requests(input, plan)) admitted.push(await input.resolution.admit(request))
  try {
    for (let index = 0; index < admitted.length; index += 1) {
      admitted[index]!.consume(await plan.requests[index]!.verify())
    }
    return await plan.execute(
      admitted[0]!.context,
      admitted.map(item => item.authority),
      admitted.map(item => item.token)
    )
  } finally {
    for (const item of admitted) item.dispose()
    await plan.dispose?.()
  }
}
