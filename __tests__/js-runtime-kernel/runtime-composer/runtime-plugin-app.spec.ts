import { describe, expect, it } from 'vitest'

import { HolonomyRuntimePluginAppV1 } from '../../../src/runtime/plugin-app.js'

const digest = (digit: string) => digit.repeat(64)
const definition = (instanceId: string, bundleSha256 = digest('a'), config = {}) => ({
  bundleSha256,
  config,
  entryUrl: `holo-plugins:///${instanceId}/index.mjs`,
  exportName: 'default',
  instanceId
})

describe('holonomy runtime Cordis plugin app', () => {
  it.each(['service', 'context'] as const)('cleans staged resources when %s construction throws', async phase => {
    const disposed: string[] = []
    const app = new HolonomyRuntimePluginAppV1({
      createContextService: (definition, lifecycle) => {
        lifecycle.registerDispose(() => {
          disposed.push(definition.instanceId)
        })
        if (definition.instanceId === 'stable') return {}
        if (phase === 'service') throw new Error('service failed')
        return Object.defineProperty({}, 'broken', {
          enumerable: true,
          get() {
            throw new Error('context failed')
          }
        })
      },
      importModule: async () => ({ default: () => {} })
    })
    await app.replace([definition('stable')])
    await expect(app.replace([definition('stable'), definition('broken', digest('b'))])).rejects.toThrow('failed')
    expect(disposed).toEqual(['broken'])
    expect(app.snapshot()).toMatchObject({ pluginGraphRevision: 1, instances: [{ instanceId: 'stable' }] })
    await app.close()
    expect(disposed).toEqual(['broken', 'stable'])
  })

  it('does not apply or publish a module that resolves after app close', async () => {
    let release!: (value: { default(): void }) => void
    let started!: () => void
    const imported = new Promise<void>(resolve => started = resolve)
    const events: string[] = []
    const app = new HolonomyRuntimePluginAppV1({
      importModule: () => {
        started()
        return new Promise(resolve => release = resolve)
      },
      publish: () => {
        events.push('published')
      }
    })
    const pending = app.replace([definition('late')])
    await imported
    await app.close()
    release({
      default: () => {
        events.push('applied')
      }
    })
    await expect(pending).rejects.toThrow('closed')
    expect(events).toEqual([])
    expect(app.snapshot()).toMatchObject({ closed: true, instances: [], pluginGraphRevision: 0 })
  })

  it('runs all registered cleanup even when one disposer throws synchronously', async () => {
    const events: string[] = []
    const app = new HolonomyRuntimePluginAppV1({
      createContextService: (_definition, lifecycle) => {
        lifecycle.registerDispose(() => {
          events.push('first')
        })
        lifecycle.registerDispose(() => {
          throw new Error('bad disposer')
        })
        lifecycle.registerDispose(() => {
          events.push('last')
        })
        return {}
      },
      importModule: async () => ({ default: () => {} })
    })
    await app.replace([definition('cleanup')])
    await app.close()
    expect(events).toEqual(['last', 'first'])
  })

  it('diffs stable instances and disposes replaced scopes after the graph revision changes', async () => {
    const events: string[] = []
    const modules = new Map([
      ['holo-plugins:///alpha/index.mjs', {
        default(ctx: { effect(callback: () => () => void): unknown }, config: { value: number }) {
          ctx.effect(() => {
            events.push(`alpha:${config.value}:install`)
            return () => events.push(`alpha:${config.value}:dispose`)
          })
        }
      }],
      ['holo-plugins:///beta/index.mjs', {
        default(ctx: { effect(callback: () => () => void): unknown }) {
          ctx.effect(() => {
            events.push('beta:install')
            return () => events.push('beta:dispose')
          })
        }
      }]
    ])
    const app = new HolonomyRuntimePluginAppV1({
      drain: async revision => {
        events.push(`drain:${revision}`)
      },
      importModule: async url => modules.get(url.slice(0, url.indexOf('?')))!
    })

    expect(await app.replace([definition('alpha', digest('a'), { value: 1 })])).toMatchObject({
      pluginGraphRevision: 1
    })
    await app.replace([
      definition('beta', digest('b')),
      definition('alpha', digest('a'), { value: 1 })
    ])
    expect(
      await app.replace([
        definition('beta', digest('b')),
        definition('alpha', digest('c'), { value: 2 })
      ])
    ).toMatchObject({
      pluginGraphRevision: 3
    })
    expect(
      await app.replace([
        definition('beta', digest('b')),
        definition('alpha', digest('c'), { value: 2 })
      ])
    ).toMatchObject({
      pluginGraphRevision: 3
    })
    await app.close()

    expect(events).toEqual([
      'alpha:1:install',
      'drain:0',
      'beta:install',
      'drain:1',
      'alpha:2:install',
      'drain:2',
      'alpha:1:dispose',
      'alpha:2:dispose',
      'beta:dispose'
    ])
  })

  it('keeps the last-known-good graph when staging fails', async () => {
    const events: string[] = []
    const app = new HolonomyRuntimePluginAppV1({
      importModule: async url => ({
        default(ctx: { effect(callback: () => () => void): unknown }) {
          if (url.includes('/broken/')) throw new Error('broken plugin')
          ctx.effect(() => {
            events.push('stable:install')
            return () => events.push('stable:dispose')
          })
        }
      })
    })
    await app.replace([definition('stable')])
    await expect(app.replace([definition('stable'), definition('broken', digest('b'))]))
      .rejects.toThrow('broken plugin')
    expect(app.snapshot()).toMatchObject({
      instances: [{ instanceId: 'stable' }],
      pluginGraphRevision: 1
    })
    await app.close()
    expect(events).toEqual(['stable:install', 'stable:dispose'])
  })
})
