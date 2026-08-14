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
