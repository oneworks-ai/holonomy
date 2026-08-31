import { HolonomyRuntimePluginAppV1 } from '@holonomyjs/runtime/app'
import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel/errors'

import { SessionModuleGraph } from './module-graph.mjs'
import { createRuntimeContext } from './runtime-context.mjs'

const definitionKey = definition =>
  JSON.stringify([
    definition.instanceId,
    definition.bundleSha256,
    definition.entryUrl,
    definition.exportName,
    definition.config
  ])

const definitions = bundles =>
  bundles.map(bundle => ({
    bundleSha256: bundle.bundleSha256,
    config: bundle.config,
    entryUrl: bundle.entryUrl,
    exportName: bundle.exportName,
    instanceId: bundle.instanceId
  }))

export class NodeRuntimePluginHostV1 {
  #app
  #bundles
  #capabilityRuntime
  #graph
  #revision
  #scopes = new Map()

  constructor(capabilityRuntime, generation, session) {
    this.#bundles = session.runtimePlugins
    this.#capabilityRuntime = capabilityRuntime
    this.#graph = new SessionModuleGraph(
      createRuntimeContext(`holonomy-host-plugins-${generation}`),
      session
    )
    this.#revision = session.pluginGraphRevision
    this.#app = new HolonomyRuntimePluginAppV1({
      createContextService: (definition, lifecycle) => this.#createService(definition, lifecycle),
      drain: revision => this.#capabilityRuntime?.drainPluginGraph(revision) ?? Promise.resolve(),
      importModule: entryUrl => this.#graph.importModule(entryUrl),
      initialRevision: this.#revision - (this.#bundles.length === 0 ? 0 : 1),
      publish: (revision, next) => {
        if (this.#capabilityRuntime == null) return
        const scopes = next.map(definition => this.#scopes.get(definitionKey(definition)))
        if (scopes.some(scope => scope == null)) throw new Error('Node Runtime plugin scope is unavailable')
        this.#capabilityRuntime?.publishPluginGraph(revision, scopes)
      }
    })
  }

  async start() {
    const snapshot = await this.#app.replace(definitions(this.#bundles))
    if (snapshot.pluginGraphRevision !== this.#revision) {
      throw new Error('Node Runtime initial plugin revision mismatch')
    }
  }

  async update(runtimePlugins, expectedRevision, revision) {
    if (expectedRevision !== this.#revision || revision !== expectedRevision + 1) {
      throw new Error('Node Runtime plugin graph revision is stale')
    }
    this.#graph.addRuntimePlugins(runtimePlugins)
    try {
      const snapshot = await this.#app.replace(definitions(runtimePlugins))
      if (snapshot.pluginGraphRevision !== revision) throw new Error('Node Runtime plugin revision mismatch')
      this.#bundles = runtimePlugins
      this.#revision = revision
      this.#graph.retainRuntimePlugins(runtimePlugins)
      return snapshot
    } catch (error) {
      this.#graph.retainRuntimePlugins(this.#bundles)
      throw error
    }
  }

  async close() {
    await this.#app.close()
  }

  #createService(definition, lifecycle) {
    if (this.#capabilityRuntime == null) return Object.freeze({})
    const key = definitionKey(definition)
    const scope = this.#capabilityRuntime.createPluginInterceptorScope(definition.instanceId)
    this.#scopes.set(key, scope)
    lifecycle.registerDispose(() => {
      if (this.#scopes.get(key) === scope) this.#scopes.delete(key)
      scope.dispose()
    })
    return Object.freeze({
      deny: invocation => {
        throw new CapabilityInvocationError(
          'middleware.permission_denied',
          invocation.operation,
          invocation.resource.requested.semanticResourceDigest
        )
      },
      intercept: (matcher, middleware, options) => scope.use(matcher, middleware, options)
    })
  }
}
