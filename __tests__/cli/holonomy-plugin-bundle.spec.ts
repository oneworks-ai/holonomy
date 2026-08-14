import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { prepareHolonomyRuntimePlugins } from '../../tools/holonomy-plugin-bundle.mjs'

const writeConfig = (root: string, plugin: Record<string, unknown>) => {
  const path = join(root, 'holo.config.json')
  writeFileSync(path, JSON.stringify({ plugins: [plugin] }))
  return path
}

describe('holonomy Runtime plugin bundles', () => {
  it('resolves package, relative, and allowed absolute sources to one hostless identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'holonomy-plugin-sources-'))
    try {
      const packageRoot = join(root, 'node_modules', '@fixture', 'permission')
      mkdirSync(packageRoot, { recursive: true })
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          holo: {
            apiVersion: 1,
            configSchema: './schema.json',
            entry: './index.mjs',
            kind: 'runtime-plugin'
          },
          name: '@fixture/permission',
          type: 'module',
          version: '1.0.0'
        })
      )
      writeFileSync(
        join(packageRoot, 'schema.json'),
        JSON.stringify({
          additionalProperties: false,
          properties: { label: { type: 'string' } },
          required: ['label'],
          type: 'object'
        })
      )
      writeFileSync(join(packageRoot, 'index.mjs'), 'export default function permission() {}')

      const entry = { config: { label: 'fixture' }, id: 'permission' }
      const packageBundle = prepareHolonomyRuntimePlugins(
        writeConfig(root, { ...entry, use: '@fixture/permission' })
      ).bundles[0]!
      const relativeBundle = prepareHolonomyRuntimePlugins(
        writeConfig(root, { ...entry, use: './node_modules/@fixture/permission' })
      ).bundles[0]!
      const absoluteBundle = prepareHolonomyRuntimePlugins(
        writeConfig(root, { ...entry, use: packageRoot }),
        { allowedAbsoluteRoots: [packageRoot] }
      ).bundles[0]!

      expect(relativeBundle.bundleSha256).toBe(packageBundle.bundleSha256)
      expect(absoluteBundle.bundleSha256).toBe(packageBundle.bundleSha256)
      expect(packageBundle.entryUrl).toBe('holo-plugins:///permission/index.mjs')
      expect(JSON.stringify(packageBundle)).not.toContain(root)
      expect(() =>
        prepareHolonomyRuntimePlugins(
          writeConfig(root, { ...entry, use: packageRoot })
        )
      ).toThrow('Absolute Holo plugin source is not allowed')
      expect(() =>
        prepareHolonomyRuntimePlugins(
          writeConfig(root, { config: { label: 1 }, id: 'permission', use: '@fixture/permission' })
        )
      ).toThrow('does not match its Schema')
      expect(() =>
        prepareHolonomyRuntimePlugins(
          writeConfig(root, {
            ...entry,
            integrity: '0'.repeat(64),
            use: '@fixture/permission'
          })
        )
      ).toThrow('integrity mismatch')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('rejects file URLs and module graphs that escape the selected source root', () => {
    const root = mkdtempSync(join(tmpdir(), 'holonomy-plugin-boundary-'))
    try {
      const pluginRoot = join(root, 'plugin')
      mkdirSync(pluginRoot)
      writeFileSync(join(root, 'outside.mjs'), 'export const secret = true')
      writeFileSync(
        join(pluginRoot, 'index.mjs'),
        "import '../outside.mjs'; export default function plugin() {}"
      )
      expect(() =>
        prepareHolonomyRuntimePlugins(
          writeConfig(root, { id: 'escape', use: './plugin/index.mjs' })
        )
      ).toThrow('escapes its source root')
      expect(() =>
        prepareHolonomyRuntimePlugins(
          writeConfig(root, { id: 'file-url', use: `file://${join(pluginRoot, 'index.mjs')}` })
        )
      ).toThrow('file: URLs are unsupported')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
