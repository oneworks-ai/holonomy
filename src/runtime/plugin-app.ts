import { Context } from 'cordis'

import { normalizeRuntimePluginDefinitionsV1, runtimePluginDefinitionKeyV1 } from './plugin-contract.js'
import type {
  RuntimePluginAppOptionsV1,
  RuntimePluginDefinitionV1,
  RuntimePluginGraphSnapshotV1
} from './plugin-types.js'

interface RuntimePluginInstanceV1 {
  readonly definition: RuntimePluginDefinitionV1
  readonly dispose: () => Promise<void>
  readonly key: string
}

export class HolonomyRuntimePluginAppV1 {
  readonly #context = new Context()
  readonly #drain
  readonly #importModule
  #closed = false
  #instances = new Map<string, RuntimePluginInstanceV1>()
  #order: readonly string[] = Object.freeze([])
  #revision = 0

  constructor(options: RuntimePluginAppOptionsV1) {
    this.#importModule = options.importModule
    this.#drain = options.drain ?? (async () => undefined)
    if (!Number.isSafeInteger(options.initialRevision ?? 0) || (options.initialRevision ?? 0) < 0) {
      throw new TypeError('Runtime plugin graph revision is invalid')
    }
    this.#revision = options.initialRevision ?? 0
  }

  async replace(input: unknown): Promise<RuntimePluginGraphSnapshotV1> {
    if (this.#closed) throw new Error('Runtime plugin app is closed')
    const definitions = normalizeRuntimePluginDefinitionsV1(input)
    if (
      definitions.length === this.#order.length &&
      definitions.every((definition, index) =>
        definition.instanceId === this.#order[index] &&
        this.#instances.get(definition.instanceId)?.key === runtimePluginDefinitionKeyV1(definition)
      )
    ) return this.snapshot()
    const staged = new Map<string, RuntimePluginInstanceV1>()
    try {
      for (const definition of definitions) {
        const key = runtimePluginDefinitionKeyV1(definition)
        const current = this.#instances.get(definition.instanceId)
        if (current?.key === key) continue
        staged.set(definition.instanceId, await this.#install(definition, key))
      }
    } catch (error) {
      await Promise.allSettled([...staged.values()].reverse().map(item => item.dispose()))
      throw error
    }
    const previous = this.#instances
    const next = new Map<string, RuntimePluginInstanceV1>()
    for (const definition of definitions) {
      next.set(
        definition.instanceId,
        staged.get(definition.instanceId) ?? previous.get(definition.instanceId)!
      )
    }
    this.#instances = next
    this.#order = Object.freeze(definitions.map(item => item.instanceId))
    const previousRevision = this.#revision
    this.#revision += 1
    const retired = [...previous.values()].filter(item => next.get(item.definition.instanceId) !== item)
    try {
      await this.#drain(previousRevision)
    } finally {
      await Promise.allSettled(retired.reverse().map(item => item.dispose()))
    }
    return this.snapshot()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const instances = [...this.#instances.values()].reverse()
    this.#instances.clear()
    this.#order = Object.freeze([])
    await Promise.allSettled(instances.map(item => item.dispose()))
  }

  snapshot(): RuntimePluginGraphSnapshotV1 {
    return Object.freeze({
      closed: this.#closed,
      instances: Object.freeze(this.#order.map(instanceId => {
        const definition = this.#instances.get(instanceId)!.definition
        return Object.freeze({
          bundleSha256: definition.bundleSha256,
          exportName: definition.exportName,
          instanceId
        })
      })),
      pluginGraphRevision: this.#revision
    })
  }

  async #install(definition: RuntimePluginDefinitionV1, key: string): Promise<RuntimePluginInstanceV1> {
    const namespace = await this.#importModule(
      `${definition.entryUrl}?holo-bundle=${definition.bundleSha256}`
    )
    const plugin = namespace[definition.exportName]
    if (
      typeof plugin !== 'function' &&
      (plugin == null || typeof plugin !== 'object' || typeof (plugin as { apply?: unknown }).apply !== 'function')
    ) throw new TypeError(`Runtime plugin export is invalid: ${definition.instanceId}`)
    const context = this.#context.extend({
      holo: Object.freeze({ instanceId: definition.instanceId })
    })
    const fiber = context.plugin(plugin as never, definition.config as never)
    await fiber
    return Object.freeze({
      definition,
      dispose: () => fiber.dispose(),
      key
    })
  }
}
