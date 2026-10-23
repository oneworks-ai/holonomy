import { describe, expect, it } from 'vitest'

import { parseHolonomyArgs } from '../../tools/holonomy-cli-options.mjs'
import { prepareHolonomyLaunchSnapshot } from '../../tools/holonomy-launch-snapshot.mjs'

describe('managed Runtime plugin startup', () => {
  it('admits static plugin installation for tests while keeping watch run-only', () => {
    for (const target of ['node', 'android', 'native']) {
      const parsed = parseHolonomyArgs([
        'test',
        '--target',
        target,
        '--config',
        './holo.config.json',
        '--plugin-root',
        './trusted',
        'case.test.mjs'
      ])
      expect(parsed).toMatchObject({
        command: 'test',
        options: { config: './holo.config.json', pluginRoots: ['./trusted'], target, watch: false }
      })
      expect(() =>
        parseHolonomyArgs([
          'test',
          '--target',
          target,
          '--config',
          './holo.config.json',
          '--watch',
          'case.test.mjs'
        ])
      ).toThrow('--watch is supported only by holonomy run')
    }
  })

  it('prepares test plugin Bundles before Service while retaining the test wrapper', async () => {
    const prepared = Object.freeze({ bundles: Object.freeze([]), configPath: '/test-only/holo.config.json' })
    let preparedInput: unknown[] | undefined
    const parsed = parseHolonomyArgs([
      'test',
      '--target',
      'node',
      '--config',
      './holo.config.json',
      '--plugin-root',
      './trusted',
      'conformance/specs/console.test.mjs'
    ])
    const snapshot = await prepareHolonomyLaunchSnapshot(parsed.command, parsed.options, {
      randomUUID: () => 'plugins-test',
      prepareRuntimePlugins: (...args: unknown[]) => {
        preparedInput = args
        return prepared
      }
    })
    expect(preparedInput).toEqual(['./holo.config.json', { allowedAbsoluteRoots: ['./trusted'] }])
    expect(snapshot.runtimePlugins).toBe(prepared.bundles)
    expect(snapshot.pluginConfigPath).toBe(prepared.configPath)
    expect(snapshot.launch.command).toBe('test')
    expect(snapshot.launch.modules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: expect.stringContaining("import { run } from 'node:test'"),
        url: snapshot.entryUrl
      })
    ]))
  })
})
