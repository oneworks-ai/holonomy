import { normalizeProcessBackendDescriptorV1 } from '../../../dist/capability-runtime/index.js'

import { createNodeEnvironmentChildV1 } from './capability-process-environment-child.mjs'

const invalid = () => {
  throw new TypeError('Invalid Node Process environment Backend')
}

class NodeProcessEnvironmentManagerV1 {
  #factory
  #records = new Map()

  constructor(factory) {
    this.#factory = factory
  }

  closeGeneration(generation) {
    return Promise.allSettled(
      [...this.#records.values()]
        .filter(record => record.generation === generation)
        .map(record => this.#close(record, 'generation-stale'))
    )
  }

  spawn(launch, options, processResourceId) {
    const key = launch.environmentScope === 'runtime'
      ? `${launch.generation}:runtime`
      : `${launch.generation}:processTree:${processResourceId}`
    let record = this.#records.get(key)
    if (record == null) {
      const controller = new AbortController()
      record = {
        closed: false,
        controller,
        environment: Promise.resolve(this.#factory.open({
          configuration: launch.configuration,
          environmentId: key,
          generation: launch.generation,
          policy: launch.policy,
          scope: launch.environmentScope,
          signal: controller.signal
        })),
        generation: launch.generation,
        key,
        scope: launch.environmentScope
      }
      this.#records.set(key, record)
      record.environment.catch(() => {
        if (this.#records.get(key) === record) this.#records.delete(key)
      })
    }
    return createNodeEnvironmentChildV1({
      environment: record.environment,
      onClose: () => {
        if (record.scope === 'processTree') void this.#close(record, 'process-complete')
      },
      request: {
        args: launch.args,
        cwd: options.cwd,
        env: options.env,
        executable: launch.executable,
        executableId: launch.executableId,
        processResourceId
      },
      stdio: options.stdio
    })
  }

  async #close(record, reason) {
    if (record.closed) return
    record.closed = true
    this.#records.delete(record.key)
    record.controller.abort(reason)
    try {
      const environment = await record.environment
      await environment.close(reason)
    } catch {
      // A failed environment has no remaining resource to close.
    }
  }
}

export const createNodeEnvironmentProcessBackendV1 = options => {
  if (
    options == null || typeof options !== 'object' ||
    typeof options.environmentFactory?.open !== 'function' ||
    typeof options.normalizeConfiguration !== 'function' ||
    typeof options.normalizeExecutable !== 'function'
  ) return invalid()
  const descriptor = normalizeProcessBackendDescriptorV1(options.descriptor)
  if (descriptor.features.synchronousSpawn) return invalid()
  const defaultCwd = options.defaultCwd ?? '/'
  if (typeof defaultCwd !== 'string' || !defaultCwd.startsWith('/')) return invalid()
  const manager = new NodeProcessEnvironmentManagerV1(options.environmentFactory)
  return Object.freeze({
    closeGeneration: generation => manager.closeGeneration(generation),
    descriptor,
    normalizeConfiguration: options.normalizeConfiguration,
    normalizeExecutable: options.normalizeExecutable,
    prepareLaunch(input) {
      return Object.freeze({
        args: Object.freeze([...input.runtimeArgs]),
        configuration: input.configuration,
        cwd: defaultCwd,
        environmentScope: input.environmentScope,
        executable: input.executable,
        executableId: input.executableId,
        generation: input.generation,
        policy: input.policy
      })
    },
    spawn(launch, spawnOptions, metadata) {
      if (typeof metadata?.processResourceId !== 'string') return invalid()
      return manager.spawn(launch, spawnOptions, metadata.processResourceId)
    },
    validateProfile: options.validateProfile ?? (() => undefined)
  })
}
