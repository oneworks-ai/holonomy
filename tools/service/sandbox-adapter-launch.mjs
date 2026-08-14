import { withFixtureUrl } from './fixture-manager.mjs'
import { compileSandboxPlan } from './sandbox-policy.mjs'

export const prepareSandboxedAdapterProcess = async ({ adapter, fixtures, process, signal }) => {
  const fixture = await fixtures.start(process)
  const fixtureRuntimeUrl = fixture == null
    ? undefined
    : await adapter.exposeFixture({ baseUrl: fixture.baseUrl, process, signal })
  return Object.freeze({ fixtureRuntimeUrl })
}

export const startSandboxedAdapterProcess = async ({
  adapter,
  capabilityRuntime,
  fixtureRuntimeUrl,
  networkRules,
  process,
  signal
}) => {
  const launchProcess = withFixtureUrl(process, fixtureRuntimeUrl)
  const sandboxPlan = compileSandboxPlan({
    generation: process.generation,
    policy: process.sandboxPolicy,
    processId: process.id,
    target: process.target
  })
  return await adapter.startProcess({
    capabilityRuntime,
    initialNetworkRuleSet: networkRules == null
      ? undefined
      : { mode: networkRules.mode, rules: networkRules.rules },
    process: launchProcess,
    sandboxPlan,
    signal
  })
}
