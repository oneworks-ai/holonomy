import { randomUUID } from 'node:crypto'
import { unwatchFile, watch, watchFile } from 'node:fs'
import path from 'node:path'

import { prepareHolonomyRuntimePlugins } from './holonomy-plugin-bundle.mjs'

const graphKey = bundles => JSON.stringify(bundles.map(bundle => [bundle.instanceId, bundle.bundleSha256]))
const observeConfigFile = (filename, callback) => {
  watchFile(filename, { interval: 500 }, callback)
  return () => unwatchFile(filename, callback)
}

export const startHolonomyPluginWatch = options => {
  const prepare = options.dependencies.prepareRuntimePlugins ?? prepareHolonomyRuntimePlugins
  const watchDirectory = options.dependencies.watchDirectory ?? watch
  const schedule = options.dependencies.scheduleWatch ?? setTimeout
  const cancel = options.dependencies.cancelWatch ?? clearTimeout
  const configPath = options.configPath
  let closed = false
  let revision = options.process.pluginGraphRevision
  let activeKey = graphKey(options.runtimePlugins)
  let timer
  let pending = Promise.resolve()

  const diagnostic = message => options.io.stderr.write(`[holonomy] ${message}\n`)
  const reload = async () => {
    if (closed) return
    try {
      const candidate = (await prepare(configPath, { allowedAbsoluteRoots: options.pluginRoots })).bundles
      if (closed) return
      const nextKey = graphKey(candidate)
      if (nextKey === activeKey) return
      const admitted = await options.client.replaceRuntimePlugins(
        options.process.id,
        { expectedGeneration: options.process.generation, runtimePlugins: candidate },
        revision,
        randomUUID()
      )
      const operation = await options.dependencies.waitForOperation(
        options.client,
        admitted.value.operation.id,
        options.dependencies
      )
      revision = operation.result.process.pluginGraphRevision
      activeKey = nextKey
      diagnostic(`Runtime plugin graph updated to revision ${revision}`)
    } catch {
      diagnostic(`Runtime plugin graph revision ${revision} remains active; candidate was rejected`)
    }
  }
  const enqueue = () => {
    if (closed) return
    cancel(timer)
    timer = schedule(() => {
      pending = pending.then(reload, reload)
    }, 75)
  }
  const watcher = watchDirectory(path.dirname(configPath), (event, filename) => {
    if (filename == null || String(filename) === path.basename(configPath)) enqueue()
  })
  watcher.on?.('error', enqueue)
  // Directory notifications may be lost/coalesced. One bounded metadata poll also
  // follows atomic editor replacement without adding a second graph/reload owner.
  let stopObserving
  try {
    stopObserving = (options.dependencies.observeConfigFile ?? observeConfigFile)(configPath, enqueue)
  } catch (error) {
    watcher.close()
    cancel(timer)
    throw error
  }
  return Object.freeze({
    async close() {
      if (closed) return
      closed = true
      cancel(timer)
      watcher.close()
      stopObserving()
      await pending
    }
  })
}
