export class NodeRuntimePluginHostV1 {
  #bundles
  #graph
  #revision
  #updater

  constructor(graph, session) {
    this.#bundles = session.runtimePlugins
    this.#graph = graph
    this.#revision = session.pluginGraphRevision
  }

  register(updater) {
    this.#updater = updater
    return true
  }

  async update(runtimePlugins, expectedRevision, revision, invoke) {
    if (this.#updater == null) throw new Error('Node Runtime plugin updater is unavailable')
    if (expectedRevision !== this.#revision || revision !== expectedRevision + 1) {
      throw new Error('Node Runtime plugin graph revision is stale')
    }
    this.#graph.addRuntimePlugins(runtimePlugins)
    const definitions = runtimePlugins.map(plugin => ({
      bundleSha256: plugin.bundleSha256,
      config: plugin.config,
      entryUrl: plugin.entryUrl,
      exportName: plugin.exportName,
      instanceId: plugin.instanceId
    }))
    try {
      const snapshot = await invoke(this.#updater, [JSON.stringify(definitions)])
      if (snapshot?.pluginGraphRevision !== revision) throw new Error('Node Runtime plugin revision mismatch')
      this.#bundles = runtimePlugins
      this.#revision = revision
      this.#graph.retainRuntimePlugins(runtimePlugins)
      return snapshot
    } catch (error) {
      this.#graph.retainRuntimePlugins(this.#bundles)
      throw error
    }
  }
}
