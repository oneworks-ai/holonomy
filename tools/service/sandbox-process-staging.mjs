import { prepareSandboxedAdapterProcess } from './sandbox-adapter-launch.mjs'

export const stageSandboxedAdapterProcess = async ({ adapter, fixtures, process, registry, signal }) => {
  const staging = await registry.updateProcess(process.id, process.generation, { state: 'staging' })
  const prepared = await prepareSandboxedAdapterProcess({ adapter, fixtures, process: staging, signal })
  await registry.finalizeProcessSandbox(process.id, process.generation, prepared)
  const starting = await registry.updateProcess(process.id, process.generation, { state: 'starting' })
  return Object.freeze({ fixtureRuntimeUrl: prepared.fixtureRuntimeUrl, process: starting })
}
