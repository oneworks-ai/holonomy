import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { HolonomyModuleLoader } from '../../../packages/runtime/src/module-loader/index.js'
import type {
  HolonomyModuleLoaderOptions,
  HostModuleLoaderPort
} from '../../../packages/runtime/src/module-loader/index.js'

const ROOT = 'app:///bundle/'

const fixture = (
  files: Record<string, string>,
  options: Partial<HolonomyModuleLoaderOptions> = {}
) => {
  const reads: string[] = []
  const sources = new Map(Object.entries(files).map(([path, source]) => [new URL(path, ROOT).toString(), source]))
  const port: HostModuleLoaderPort = {
    readModule(url) {
      reads.push(url)
      const source = sources.get(url)
      if (source == null) return null
      const bytes = new TextEncoder().encode(source)
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    },
    syntheticNodeModules: { 'node:path': { exportNames: ['default', 'join'] } }
  }
  return { loader: new HolonomyModuleLoader(port, { rootUrl: ROOT, ...options }), reads }
}

const packageJson = (value: Record<string, unknown>) => JSON.stringify(value)

describe('shared package imports resolution', () => {
  it('does not treat inherited registry entries or Object prototype names as declared builtins', async () => {
    const modules = Object.create({
      'node:fake': { exportNames: ['default'] },
      constructor: { exportNames: ['default'] }
    })
    const loader = new HolonomyModuleLoader({ readModule: () => null, syntheticNodeModules: modules }, {
      rootUrl: ROOT
    })
    await expect(loader.resolve('fake')).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_NOT_FOUND' })
    await expect(loader.resolve('constructor')).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_NOT_FOUND' })
    await expect(loader.resolve('node:fake')).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_SYNTHETIC_NOT_FOUND' })
  })

  it('resolves exact, pattern and nested condition targets by manifest key order', async () => {
    const { loader } = fixture({
      'package.json': packageJson({
        type: 'module',
        imports: {
          '#exact': './exact.mjs',
          '#priority/*': './generic/*.mjs',
          '#priority/s*': './specific/*.mjs',
          '#priority/special-null': null,
          '#star*': './star/*',
          '#ordered': { default: './default.mjs', import: './import.mjs' },
          '#nested': { import: { default: './nested.mjs' }, default: './default.mjs' },
          '#nested-block': { import: { default: null }, default: './default.mjs' },
          '#array-fallthrough': { import: [{ custom: './other.mjs' }], default: './default.mjs' }
        }
      }),
      'exact.mjs': '',
      'specific/pecial.mjs': '',
      'default.mjs': '',
      'import.mjs': '',
      'nested.mjs': '',
      'star/*': 'export default 1'
    })
    expect(await loader.resolve('#exact')).toBe(`${ROOT}exact.mjs`)
    expect(await loader.resolve('#priority/special')).toBe(`${ROOT}specific/pecial.mjs`)
    expect(await loader.resolve('#ordered')).toBe(`${ROOT}default.mjs`)
    expect(await loader.resolve('#nested')).toBe(`${ROOT}nested.mjs`)
    expect(await loader.resolve('#array-fallthrough')).toBe(`${ROOT}default.mjs`)
    expect(await loader.resolve('#star*')).toBe(`${ROOT}star/*`)
    await expect(loader.resolve('#priority/special-null')).rejects.toMatchObject({
      code: 'ERR_PACKAGE_IMPORT_NOT_DEFINED'
    })
    await expect(loader.resolve('#nested-block')).rejects.toMatchObject({
      code: 'ERR_PACKAGE_IMPORT_NOT_DEFINED'
    })
  })

  it('plans import, CommonJS require, JSON and declared bare builtins through one loader', async () => {
    const { loader } = fixture({
      'package.json': packageJson({
        type: 'module',
        imports: {
          '#local': './local.mjs',
          '#json': './data.json',
          '#core': 'path',
          '#mode': { require: './required.cjs', import: './imported.mjs' }
        }
      }),
      'entry.mjs': "import '#local'; import '#json'; import '#core'; import '#mode'",
      'entry.cjs': "module.exports = require('#mode'); require.resolve('#core')",
      'local.mjs': '',
      'data.json': '{"answer":42}',
      'required.cjs': 'module.exports = 42',
      'imported.mjs': 'export default 42'
    }, { allowJsonModules: true })
    const esm = await loader.createPlan('./entry.mjs')
    expect(esm.modules.map(module => module.url)).toEqual(expect.arrayContaining([
      `${ROOT}local.mjs`,
      `${ROOT}data.json`,
      `${ROOT}imported.mjs`,
      'node:path'
    ]))
    const cjs = await loader.createPlan('./entry.cjs')
    expect(cjs.modules.map(module => module.url)).toContain(`${ROOT}required.cjs`)
    expect(cjs.modules.find(module => module.url.endsWith('/entry.cjs'))?.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ specifier: '#mode', resolvedUrl: `${ROOT}required.cjs` }),
      expect.objectContaining({ specifier: '#core', resolvedUrl: 'node:path' })
    ]))
    expect(await loader.resolve('path')).toBe('node:path')
  })

  it('resolves external packages and own-name exports from the import map', async () => {
    const { loader } = fixture({
      'package.json': packageJson({
        name: 'own',
        type: 'module',
        exports: { './self': { default: './self.mjs', import: './other.mjs' } },
        imports: { '#external': 'outside/sub', '#pattern/*': 'outside/*', '#self': 'own/self' }
      }),
      'self.mjs': '',
      'other.mjs': '',
      'node_modules/outside/package.json': packageJson({ exports: { './sub': './sub.mjs' } }),
      'node_modules/outside/sub.mjs': ''
    })
    expect(await loader.resolve('#external')).toBe(`${ROOT}node_modules/outside/sub.mjs`)
    expect(await loader.resolve('#pattern/sub')).toBe(`${ROOT}node_modules/outside/sub.mjs`)
    expect(await loader.resolve('#self')).toBe(`${ROOT}self.mjs`)
    expect(await loader.resolve('own/self')).toBe(`${ROOT}self.mjs`)
  })

  it('keeps nearest package scope and stops at a node_modules boundary', async () => {
    const { loader, reads } = fixture({
      'package.json': packageJson({ imports: { '#outer': './outer.mjs' } }),
      'outer.mjs': '',
      'nested/package.json': packageJson({ imports: { '#own': './own.mjs' } }),
      'nested/own.mjs': ''
    })
    expect(await loader.resolve('#own', `${ROOT}nested/deep/entry.mjs`)).toBe(`${ROOT}nested/own.mjs`)
    await expect(loader.resolve('#outer', `${ROOT}nested/deep/entry.mjs`)).rejects.toMatchObject({
      code: 'ERR_PACKAGE_IMPORT_NOT_DEFINED'
    })
    reads.length = 0
    await expect(loader.resolve('#outer', `${ROOT}node_modules/orphan/lib/entry.mjs`)).rejects.toMatchObject({
      code: 'ERR_PACKAGE_IMPORT_NOT_DEFINED'
    })
    expect(reads).not.toContain(`${ROOT}package.json`)
  })

  it('uses array null and invalid-target fallback, but does not retry a missing file', async () => {
    const { loader, reads } = fixture({
      'package.json': packageJson({
        imports: {
          '#null': [null, './good.mjs'],
          '#empty': [],
          '#invalid': ['../escape.mjs', './good.mjs'],
          '#blocked': ['./good.mjs', null],
          '#missing-file': ['./absent.mjs', './good.mjs'],
          '#all-blocked': ['../escape.mjs', null],
          '#only-invalid': ['../escape.mjs'],
          '#null-then-invalid': [null, '../escape.mjs']
        }
      }),
      'good.mjs': ''
    })
    expect(await loader.resolve('#null')).toBe(`${ROOT}good.mjs`)
    expect(await loader.resolve('#invalid')).toBe(`${ROOT}good.mjs`)
    expect(await loader.resolve('#blocked')).toBe(`${ROOT}good.mjs`)
    await expect(loader.resolve('#all-blocked')).rejects.toMatchObject({ code: 'ERR_PACKAGE_IMPORT_NOT_DEFINED' })
    await expect(loader.resolve('#empty')).rejects.toMatchObject({ code: 'ERR_PACKAGE_IMPORT_NOT_DEFINED' })
    await expect(loader.resolve('#only-invalid')).rejects.toMatchObject({ code: 'ERR_INVALID_PACKAGE_TARGET' })
    await expect(loader.resolve('#null-then-invalid')).rejects.toMatchObject({ code: 'ERR_INVALID_PACKAGE_TARGET' })
    expect(await loader.resolve('#missing-file')).toBe(`${ROOT}absent.mjs`)
    expect(reads).not.toContain(`${ROOT}absent.mjs`)
    await expect(loader.createPlan('#missing-file')).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_NOT_FOUND' })
    expect(reads).toContain(`${ROOT}absent.mjs`)
    expect(reads).not.toContain(`${ROOT}good.mjs`)
  })

  it('rejects malformed names, invalid maps and forbidden targets before a Host source read', async () => {
    const names = ['#', '#/bad', '#path/', '#x/../secret', '#x/%2e%2e/secret', '#x\\bad']
    for (const name of names) {
      const { loader, reads } = fixture({})
      await expect(loader.resolve(name)).rejects.toMatchObject({ code: 'ERR_INVALID_MODULE_SPECIFIER' })
      expect(reads).toEqual([])
    }

    for (
      const target of [
        '/absolute.mjs',
        '../escape.mjs',
        './node_modules/hidden.mjs',
        './%2e%2e/escape.mjs',
        './%252e%252e/escape.mjs',
        'data:text/javascript,1',
        'node:path'
      ]
    ) {
      const { loader, reads } = fixture({ 'package.json': packageJson({ imports: { '#x': target } }) })
      await expect(loader.resolve('#x')).rejects.toMatchObject({ code: 'ERR_INVALID_PACKAGE_TARGET' })
      expect(reads).toEqual([`${ROOT}package.json`])
    }
    const encodedSeparator = fixture({ 'package.json': packageJson({ imports: { '#x': './a/%2f/b.mjs' } }) })
    await expect(encodedSeparator.loader.resolve('#x')).rejects.toMatchObject({ code: 'ERR_INVALID_MODULE_SPECIFIER' })
    expect(encodedSeparator.reads).toEqual([`${ROOT}package.json`])
    const cycle = fixture({ 'package.json': packageJson({ imports: { '#x': '#y', '#y': '#x' } }) })
    await expect(cycle.loader.resolve('#x')).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_NOT_FOUND' })
    expect(cycle.reads).toEqual([`${ROOT}package.json`])
    const unusedBadKey = fixture({
      'package.json': packageJson({ imports: { '#x': './good.mjs', '#/bad': './missing.mjs' } }),
      'good.mjs': ''
    })
    expect(await unusedBadKey.loader.resolve('#x')).toBe(`${ROOT}good.mjs`)
    for (const imports of [[], { '#x': { 0: './good.mjs' } }]) {
      const { loader } = fixture({ 'package.json': packageJson({ imports }) })
      await expect(loader.resolve('#x')).rejects.toMatchObject({
        code: 'ERR_HOLONOMY_MODULE_INVALID_PACKAGE_CONFIG'
      })
    }
    const nullImports = fixture({ 'package.json': packageJson({ imports: null }) })
    await expect(nullImports.loader.resolve('#x')).rejects.toMatchObject({ code: 'ERR_PACKAGE_IMPORT_NOT_DEFINED' })
  })

  it('uses exact mapped URLs without probing extension or directory-index candidates', async () => {
    const { loader, reads } = fixture({
      'package.json': packageJson({
        type: 'module',
        imports: { '#file': './feature', '#directory': './directory', '#missing': './absent' }
      }),
      'feature': 'export const value = 1',
      'directory/index.js': 'export const value = 2',
      'absent.mjs': 'export const value = 3'
    })
    expect(await loader.resolve('#file')).toBe(`${ROOT}feature`)
    expect(await loader.resolve('#directory')).toBe(`${ROOT}directory`)
    expect(await loader.resolve('#missing')).toBe(`${ROOT}absent`)
    expect(reads).toEqual([`${ROOT}package.json`])
    const file = await loader.createPlan('#file')
    expect(file.modules.find(module => module.url === `${ROOT}feature`)?.format).toBe('module')
    await expect(loader.createPlan('#directory')).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_NOT_FOUND' })
    await expect(loader.createPlan('#missing')).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_NOT_FOUND' })
    expect(reads).not.toContain(`${ROOT}directory/index.js`)
    expect(reads).not.toContain(`${ROOT}absent.mjs`)

    const commonJs = fixture({
      'package.json': packageJson({ type: 'commonjs', imports: { '#file': './feature' } }),
      'feature': 'module.exports = 1'
    })
    expect((await commonJs.loader.createPlan('#file')).modules[0]?.format).toBe('commonjs')
  })

  it('keeps exports-present external package targets exact', async () => {
    const { loader, reads } = fixture({
      'package.json': packageJson({ imports: { '#external': 'outside/feature' } }),
      'node_modules/outside/package.json': packageJson({ exports: { './feature': './feature' } }),
      'node_modules/outside/feature.mjs': 'export default 1',
      'node_modules/outside/feature/index.js': 'export default 2'
    })
    expect(await loader.resolve('#external')).toBe(`${ROOT}node_modules/outside/feature`)
    expect(reads).not.toContain(`${ROOT}node_modules/outside/feature.mjs`)
    await expect(loader.createPlan('#external')).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_NOT_FOUND' })
    expect(reads).not.toContain(`${ROOT}node_modules/outside/feature.mjs`)
    expect(reads).not.toContain(`${ROOT}node_modules/outside/feature/index.js`)
  })

  it('bounds deeply nested conditions and rolls back a failed resolution', async () => {
    let target: unknown = './good.mjs'
    for (let depth = 0; depth < 40; depth++) target = { default: target }
    const { loader, reads } = fixture({
      'package.json': packageJson({ imports: { '#deep': target, '#good': './good.mjs' } }),
      'good.mjs': ''
    })
    await expect(loader.resolve('#deep')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    })
    expect(await loader.resolve('#good')).toBe(`${ROOT}good.mjs`)
    expect(reads.filter(url => url === `${ROOT}package.json`)).toHaveLength(2)
  })
})
