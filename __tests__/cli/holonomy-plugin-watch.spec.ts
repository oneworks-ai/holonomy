import { describe, expect, it } from 'vitest'

import { startHolonomyPluginWatch } from '../../tools/holonomy-plugin-watch.mjs'

describe('plugin config watcher reconciliation', () => {
  it('reconciles through metadata when directory notifications are lost and closes both observers', async () => {
    const bundle = (digest: string) => ({
      instanceId: 'test',
      bundleSha256: digest.repeat(64),
      schemaVersion: 1 as const,
      config: {},
      files: [],
      exportName: 'default',
      entryUrl: 'holo-plugins:///test/index.mjs' as const,
      rootUrl: 'holo-plugins:///test/' as const
    })
    let changed!: () => void
    let scheduled: (() => void) | undefined
    let closedDirectory = 0
    let closedMetadata = 0
    let replacements = 0
    let prepared = 0
    let finish!: () => void
    const applied = new Promise<void>(resolve => finish = resolve)
    let reconciled!: () => void
    const repeated = new Promise<void>(resolve => reconciled = resolve)
    const watcher = startHolonomyPluginWatch({
      client: {
        async replaceRuntimePlugins() {
          replacements += 1
          return { value: { operation: { id: 'op' } } }
        }
      },
      configPath: '/config/holo.config.json',
      dependencies: {
        async prepareRuntimePlugins() {
          prepared += 1
          if (prepared === 2) reconciled()
          return { bundles: [bundle('b')] }
        },
        watchDirectory: () => ({ close: () => closedDirectory += 1, on: () => undefined }),
        observeConfigFile: (_filename: string, callback: () => void) => {
          changed = callback
          return () => closedMetadata += 1
        },
        scheduleWatch: (callback: () => void) => {
          scheduled = callback
          return 1
        },
        cancelWatch: () => scheduled = undefined,
        waitForOperation: async () => ({ result: { process: { pluginGraphRevision: 2 } } })
      },
      io: { stderr: { write: () => finish() } },
      pluginRoots: [],
      process: { id: 'process', generation: 1, pluginGraphRevision: 1 },
      runtimePlugins: [bundle('a')]
    })
    changed()
    scheduled!()
    await applied
    changed()
    scheduled!()
    await repeated
    await watcher.close()
    await watcher.close()
    expect(replacements).toBe(1)
    expect(prepared).toBe(2)
    expect(closedDirectory).toBe(1)
    expect(closedMetadata).toBe(1)
    changed()
    expect(scheduled).toBeUndefined()
  })

  it('does not publish an async candidate after the watcher closes', async () => {
    let changed!: () => void
    let scheduled!: () => void
    let begin!: () => void
    let release!: (value: { bundles: readonly typeof bundle[] }) => void
    const started = new Promise<void>(resolve => begin = resolve)
    const candidate = new Promise<{ bundles: readonly typeof bundle[] }>(resolve => release = resolve)
    const bundle = {
      bundleSha256: 'a'.repeat(64),
      config: {},
      entryUrl: 'holo-plugins:///test/index.mjs' as const,
      exportName: 'default',
      files: [],
      instanceId: 'test',
      rootUrl: 'holo-plugins:///test/' as const,
      schemaVersion: 1 as const
    }
    let replacements = 0
    const watcher = startHolonomyPluginWatch({
      client: {
        async replaceRuntimePlugins() {
          replacements += 1
          return { value: { operation: { id: 'op' } } }
        }
      },
      configPath: '/config/holo.config.json',
      dependencies: {
        async prepareRuntimePlugins() {
          begin()
          return candidate
        },
        watchDirectory: () => ({ close: () => undefined }),
        observeConfigFile: (_filename: string, callback: () => void) => {
          changed = callback
          return () => undefined
        },
        scheduleWatch: callback => {
          scheduled = callback
          return 1
        },
        cancelWatch: () => undefined,
        waitForOperation: async () => ({ result: { process: { pluginGraphRevision: 2 } } })
      },
      io: { stderr: { write: () => undefined } },
      pluginRoots: [],
      process: { id: 'process', generation: 1, pluginGraphRevision: 1 },
      runtimePlugins: []
    })
    changed()
    scheduled()
    await started
    const closing = watcher.close()
    release({ bundles: [bundle] })
    await closing
    expect(replacements).toBe(0)
  })
})
