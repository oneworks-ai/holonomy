import { serviceError } from './errors.mjs'
import { getResource, requireExpectedGeneration, touchResource } from './registry-helpers.mjs'
import { compileEffectiveSandboxPolicy } from './sandbox-policy.mjs'
import { cloneJson } from './validation.mjs'

export const finalizeProcessSandbox = async (context, id, expectedGeneration, input = {}) => {
  const now = context.now()
  return await context.store.transact(
    result => ({
      data: { generation: result.generation, sandboxPolicyDigest: result.sandboxPolicyDigest },
      subject: id,
      type: 'process.sandbox.finalized'
    }),
    draft => {
      const process = getResource(draft, 'processes', id, 'Runtime process')
      requireExpectedGeneration(process, expectedGeneration)
      if (!['queued', 'staging'].includes(process.state)) {
        throw serviceError('service.conflict', 'Runtime process sandbox can only be finalized during staging')
      }
      const fixtureRuntimeUrl = input.fixtureRuntimeUrl
      if ((process.fixture == null) !== (fixtureRuntimeUrl == null)) {
        throw serviceError('service.invalid_request', 'Runtime fixture lease does not match its descriptor')
      }
      if (process.fixtureRuntimeUrl != null && process.fixtureRuntimeUrl !== fixtureRuntimeUrl) {
        throw serviceError('service.conflict', 'Runtime fixture origin changed across process generations')
      }
      const effective = compileEffectiveSandboxPolicy(process.sandboxPolicyRequested, fixtureRuntimeUrl)
      if (process.sandboxPolicyFinalizedGeneration === process.generation) {
        if (process.sandboxPolicyDigest !== effective.digest) {
          throw serviceError('service.conflict', 'Runtime sandbox finalization changed within one generation')
        }
        return cloneJson(process)
      }
      process.sandboxPolicy = effective.policy
      process.sandboxPolicyDigest = effective.digest
      process.sandboxPolicyFinalizedGeneration = process.generation
      if (fixtureRuntimeUrl != null) process.fixtureRuntimeUrl = fixtureRuntimeUrl
      touchResource(process, now)
      return cloneJson(process)
    }
  )
}
