import { HoloUvEnvironmentRuntimeV1 } from '@holonomyjs/holouv'

import { normalizeProcessBackendDescriptorV1 } from '../../../dist/capability-runtime/index.js'

import { createNodeEnvironmentChildV1 } from './capability-process-environment-child.mjs'

const invalid = () => {
  throw new TypeError('Invalid Node Process environment Backend')
}

export const createNodeEnvironmentProcessBackendV1 = options => {
  if (
    options == null || typeof options !== 'object' ||
    typeof options.environmentFactory?.open !== 'function' ||
    typeof options.normalizeConfiguration !== 'function' ||
    typeof options.normalizeExecutable !== 'function' ||
    options.validateLaunch != null && typeof options.validateLaunch !== 'function'
  ) return invalid()
  const descriptor = normalizeProcessBackendDescriptorV1(options.descriptor)
  if (descriptor.features.synchronousSpawn) return invalid()
  const defaultCwd = options.defaultCwd ?? '/'
  if (typeof defaultCwd !== 'string' || !defaultCwd.startsWith('/')) return invalid()
  const runtime = new HoloUvEnvironmentRuntimeV1(options.environmentFactory)
  return Object.freeze({
    closeGeneration: generation => runtime.closeGeneration(generation),
    descriptor,
    normalizeConfiguration: options.normalizeConfiguration,
    normalizeExecutable: options.normalizeExecutable,
    prepareLaunch(input) {
      options.validateLaunch?.(input)
      return Object.freeze({
        args: Object.freeze([...input.runtimeArgs]),
        configuration: input.configuration,
        cwd: defaultCwd,
        executables: Object.freeze(Array.isArray(input.executables) ? [...input.executables] : []),
        environmentScope: input.environmentScope,
        executable: input.executable,
        executableId: input.executableId,
        generation: input.generation,
        policy: input.policy
      })
    },
    spawn(launch, spawnOptions, metadata) {
      if (typeof metadata?.processResourceId !== 'string') return invalid()
      const lease = runtime.acquire({
        configuration: launch.configuration,
        executables: launch.executables,
        generation: launch.generation,
        policy: launch.policy,
        scope: launch.environmentScope
      }, metadata.processResourceId)
      return createNodeEnvironmentChildV1({
        environment: lease.environment,
        onClose: () => void lease.release(),
        request: {
          args: launch.args,
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          executable: launch.executable,
          executableId: launch.executableId,
          processResourceId: metadata.processResourceId
        },
        stdio: spawnOptions.stdio
      })
    },
    validateProfile: options.validateProfile ?? (() => undefined)
  })
}
