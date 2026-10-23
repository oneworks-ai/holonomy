import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { normalizeRuntimePluginBundlesV2 } from '../../packages/runtime/src/app/plugin-bundle-v2.js'
import { prepareHolonomyRuntimePluginsNative } from '../../tools/holonomy-native-plugin-bundle.mjs'
import { prepareHolonomyRuntimePlugins } from '../../tools/holonomy-plugin-bundle.mjs'

const root = '/native-only-workspace'
const packageRoot = join(root, 'node_modules', '@fixture', 'permission')
const configPath = join(root, 'holo.config.json')
const manifestPath = join(packageRoot, 'package.json')
const schemaPath = join(packageRoot, 'schema.json')
const entryPath = join(packageRoot, 'index.mjs')
const dependencyPath = join(packageRoot, 'dep.mjs')

const manifest = JSON.stringify({
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
const schema = JSON.stringify({
  additionalProperties: false,
  properties: { label: { type: 'string' } },
  required: ['label'],
  type: 'object'
})
const entry = "import './dep.mjs'; import 'cordis'; export default function permission() {}"
const dependency = 'export const name = "permission"'

const fixtureFiles = new Map([
  [manifestPath, manifest],
  [schemaPath, schema],
  [entryPath, entry],
  [dependencyPath, dependency]
])

const recordingReader = (
  config: string,
  extraFiles: readonly [string, string][] = [],
  options: {
    legacyPackage?: boolean
    canonicalRoot?: string
    configFile?: string
    rejectParentLink?: boolean
    physicalPackageRoot?: string
  } = {}
) => {
  const selectedPackageRoot = options.physicalPackageRoot ?? packageRoot
  const selectedManifestPath = join(selectedPackageRoot, 'package.json')
  const files = new Map([
    ...[...fixtureFiles].map(([file, source]) =>
      [
        join(selectedPackageRoot, file.slice(packageRoot.length + 1)),
        source
      ] as const
    ),
    ...extraFiles,
    [options.configFile ?? configPath, config]
  ])
  const captured: string[] = []
  const reads: { path: string; kind: string }[] = []
  const packageOpens: { root: string; path: string }[] = []
  const packageReads: { relativePath: string; kind: string }[] = []
  return {
    captured,
    reads,
    packageOpens,
    packageReads,
    async statPrivate(path: string): Promise<
      | { kind: 'file'; size: number; mtimeMs: number }
      | { kind: 'directory'; size: number; mtimeMs: number }
      | { kind: 'missing' }
    > {
      if (options.rejectParentLink && path === selectedPackageRoot) {
        throw Object.assign(new Error('source_rejected'), { code: 'source_rejected' })
      }
      if (path === selectedPackageRoot) return { kind: 'directory', size: 0, mtimeMs: 1 }
      return files.has(path)
        ? { kind: 'file', size: Buffer.byteLength(files.get(path)!), mtimeMs: 1 }
        : { kind: 'missing' }
    },
    async capturePrivate(path: string) {
      if (!files.has(path)) throw new Error('fixture capture failed')
      captured.push(path)
      return { kind: 'file' as const, size: Buffer.byteLength(files.get(path)!), mtimeMs: 1 }
    },
    async readPrivate(path: string, kind: string) {
      expect(captured).toContain(path)
      reads.push({ path, kind })
      const source = files.get(path)
      if (source == null) return null
      const bytes = Buffer.from(source)
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    },
    async openPrivatePackage(rootPath: string, requestedManifest: string) {
      packageOpens.push({ root: rootPath, path: requestedManifest })
      if (options.legacyPackage || requestedManifest !== selectedManifestPath) return null
      const source = files.get(selectedManifestPath)!
      const bytes = Buffer.from(source)
      return {
        packageId: 'pinned-package',
        rootPath: options.canonicalRoot ?? selectedPackageRoot,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
    },
    async readPrivatePackage(packageId: string, relativePath: string, kind: string) {
      expect(packageId).toBe('pinned-package')
      packageReads.push({ relativePath, kind })
      const source = files.get(join(selectedPackageRoot, relativePath))
      if (source == null) return null
      const bytes = Buffer.from(source)
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
  }
}

describe('native-backed Holo plugin bundle preparation', () => {
  it('uses only Native reader bytes for package, schema, and transitive modules', async () => {
    const config = JSON.stringify({
      plugins: [{ config: { label: 'fixture' }, id: 'permission', use: '@fixture/permission' }]
    })
    const reader = recordingReader(config)
    const native = await prepareHolonomyRuntimePluginsNative(configPath, { reader })
    expect(reader.reads).toEqual([{ path: configPath, kind: 'config' }])
    expect(reader.packageOpens).toEqual([{ root, path: manifestPath }])
    expect(reader.packageReads).toEqual([
      { relativePath: 'schema.json', kind: 'schema' },
      { relativePath: 'index.mjs', kind: 'module' },
      { relativePath: 'dep.mjs', kind: 'module' }
    ])
    const firstBundle = native.bundles[0]
    if (firstBundle?.schemaVersion !== 1) throw new Error('Expected a V1 plugin fixture')
    expect(firstBundle.files.map((file: { url: string }) => file.url)).toEqual([
      'holo-plugins:///permission/dep.mjs',
      'holo-plugins:///permission/index.mjs'
    ])
    expect(JSON.stringify(native.bundles)).not.toContain(root)

    for (
      const [use, allowedAbsoluteRoots] of [
        ['./node_modules/@fixture/permission', undefined],
        [packageRoot, [packageRoot]]
      ] as const
    ) {
      const variant = recordingReader(JSON.stringify({
        plugins: [{ config: { label: 'fixture' }, id: 'permission', use }]
      }))
      const prepared = await prepareHolonomyRuntimePluginsNative(configPath, {
        reader: variant,
        allowedAbsoluteRoots
      })
      expect(prepared.bundles[0]?.bundleSha256).toBe(native.bundles[0]?.bundleSha256)
    }
    await expect(prepareHolonomyRuntimePluginsNative(configPath, {
      reader: recordingReader(JSON.stringify({
        plugins: [{ config: { label: 'fixture' }, id: 'permission', use: packageRoot }]
      }))
    })).rejects.toThrow('Absolute Holo plugin source is not allowed')

    const actual = mkdtempSync(join(tmpdir(), 'holo-native-bundle-parity-'))
    try {
      const actualPackage = join(actual, 'node_modules', '@fixture', 'permission')
      mkdirSync(actualPackage, { recursive: true })
      writeFileSync(join(actual, 'holo.config.json'), config)
      for (const [file, source] of fixtureFiles) {
        writeFileSync(join(actualPackage, file.slice(packageRoot.length + 1)), source)
      }
      const legacy = prepareHolonomyRuntimePlugins(join(actual, 'holo.config.json'))
      expect(native.bundles).toEqual(legacy.bundles)
    } finally {
      rmSync(actual, { recursive: true, force: true })
    }
  })

  it('admits exact package names and rejects subpaths before any package operation', async () => {
    for (
      const [use, subpath, selectedPackageRoot] of [
        ['plainpkg', 'plainpkg/subpath', join(root, 'node_modules', 'plainpkg')],
        ['@fixture/permission', '@fixture/permission/subpath', packageRoot]
      ]
    ) {
      const files: [string, string][] = [[
        join(selectedPackageRoot, 'package.json'),
        JSON.stringify({ ...JSON.parse(manifest), name: use })
      ]]
      const config = (source: string) =>
        JSON.stringify({
          plugins: [{ config: { label: 'fixture' }, id: 'permission', use: source }]
        })
      const healthy = recordingReader(config(use), files, { physicalPackageRoot: selectedPackageRoot })
      const prepared = await prepareHolonomyRuntimePluginsNative(configPath, { reader: healthy })
      expect(prepared.bundles).toHaveLength(1)
      expect(healthy.packageOpens).toHaveLength(1)

      const invalid = recordingReader(config(subpath), files, { physicalPackageRoot: selectedPackageRoot })
      await expect(prepareHolonomyRuntimePluginsNative(configPath, { reader: invalid }))
        .rejects.toThrow('Holo plugin package name is invalid')
      expect(invalid.reads).toEqual([{ path: configPath, kind: 'config' }])
      expect(invalid.packageOpens).toEqual([])
      expect(invalid.packageReads).toEqual([])
    }
  })

  it('rejects an escaping dependency before reading its bytes', async () => {
    const config = JSON.stringify({ plugins: [{ id: 'permission', use: './index.mjs' }] })
    const reader = recordingReader(config)
    const local = join(root, 'index.mjs')
    const outside = join(root, '..', 'outside.mjs')
    const source = "import '../outside.mjs'; export default function permission() {}"
    const originalStat = reader.statPrivate
    const originalRead = reader.readPrivate
    reader.statPrivate = async path =>
      path === local
        ? { kind: 'file', size: Buffer.byteLength(source), mtimeMs: 1 }
        : originalStat(path)
    reader.capturePrivate = async path => {
      reader.captured.push(path)
      return { kind: 'file', size: path === local ? Buffer.byteLength(source) : 0, mtimeMs: 1 }
    }
    reader.readPrivate = async (path, kind) => {
      if (path === local) {
        const bytes = Buffer.from(source)
        return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
      }
      return originalRead(path, kind)
    }
    await expect(prepareHolonomyRuntimePluginsNative(configPath, { reader }))
      .rejects.toThrow('escapes its source root')
    expect(reader.reads.some(record => record.path === outside)).toBe(false)
  })

  it('accepts exactly one MiB pinned, rejects +1, and retains legacy physical manifests over one MiB', async () => {
    const config = JSON.stringify({
      plugins: [{ config: { label: 'fixture' }, id: 'permission', use: '@fixture/permission' }]
    })
    const holo = {
      kind: 'runtime-plugin',
      apiVersion: 1,
      entry: './index.mjs',
      configSchema: './schema.json'
    }
    const empty = JSON.stringify({ description: '', holo })
    const padding = 1024 * 1024 - Buffer.byteLength(empty)
    const atLimit = JSON.stringify({ description: 'x'.repeat(padding), holo })
    const overLimit = JSON.stringify({ description: 'x'.repeat(padding + 1), holo })
    expect(Buffer.byteLength(atLimit)).toBe(1024 * 1024)
    expect(Buffer.byteLength(overLimit)).toBe(1024 * 1024 + 1)

    const pinned = recordingReader(config, [[manifestPath, atLimit]])
    const accepted = await prepareHolonomyRuntimePluginsNative(configPath, { reader: pinned })
    expect(accepted.bundles).toHaveLength(1)
    expect(pinned.reads).toEqual([{ path: configPath, kind: 'config' }])

    const oversized = recordingReader(config, [[manifestPath, overLimit]])
    await expect(prepareHolonomyRuntimePluginsNative(configPath, { reader: oversized }))
      .rejects.toThrow('exceeds the size limit')
    const legacy = recordingReader(config, [[manifestPath, overLimit]], { legacyPackage: true })
    const prepared = await prepareHolonomyRuntimePluginsNative(configPath, { reader: legacy })
    expect(prepared.bundles).toHaveLength(1)
    expect(legacy.reads.some(read => read.path === manifestPath && read.kind === 'manifest')).toBe(true)
  })

  it('keeps physical ancestor package lookup and rejects a linked ancestor package', async () => {
    const nestedConfig = join(root, 'app', 'holo.config.json')
    const config = JSON.stringify({
      plugins: [{ config: { label: 'fixture' }, id: 'permission', use: '@fixture/permission' }]
    })
    const physical = recordingReader(config, [], { configFile: nestedConfig, legacyPackage: true })
    const prepared = await prepareHolonomyRuntimePluginsNative(nestedConfig, { reader: physical })
    expect(prepared.bundles).toHaveLength(1)
    expect(physical.reads.some(read => read.path === manifestPath && read.kind === 'manifest')).toBe(true)
    expect(physical.packageOpens).toEqual([{
      root: join(root, 'app'),
      path: join(root, 'app', 'node_modules', '@fixture', 'permission', 'package.json')
    }])

    const linked = recordingReader(config, [], {
      configFile: nestedConfig,
      rejectParentLink: true
    })
    await expect(prepareHolonomyRuntimePluginsNative(nestedConfig, { reader: linked }))
      .rejects.toMatchObject({ code: 'source_rejected' })
    expect(linked.packageOpens).toEqual(physical.packageOpens)
  })

  it('preserves virtual paths and digest through a pinned pnpm-style package link', async () => {
    const config = JSON.stringify({
      plugins: [{ config: { label: 'fixture' }, id: 'permission', use: '@fixture/permission' }]
    })
    const physical = await prepareHolonomyRuntimePluginsNative(configPath, {
      reader: recordingReader(config)
    })
    const canonicalRoot = join(root, 'node_modules', '.pnpm', 'fixture@1.0.0', 'node_modules', '@fixture', 'permission')
    const linked = recordingReader(config, [], { canonicalRoot })
    const pinned = await prepareHolonomyRuntimePluginsNative(configPath, { reader: linked })
    expect(pinned.bundles).toEqual(physical.bundles)
    expect(linked.reads).toEqual([{ path: configPath, kind: 'config' }])
    expect(linked.packageReads.map(read => read.relativePath)).toEqual([
      'schema.json',
      'index.mjs',
      'dep.mjs'
    ])
  })

  it('rejects a bare package import before any extra package read', async () => {
    const config = JSON.stringify({
      plugins: [{ config: { label: 'fixture' }, id: 'permission', use: '@fixture/permission' }]
    })
    const unsupported = recordingReader(config, [[
      entryPath,
      "import 'ordinary-dependency'; export default function plugin() {}"
    ]])
    await expect(prepareHolonomyRuntimePluginsNative(configPath, { reader: unsupported }))
      .rejects.toThrow('Unsupported Holo plugin import')
    expect(unsupported.packageReads).toEqual([{ relativePath: 'schema.json', kind: 'schema' }, {
      relativePath: 'index.mjs',
      kind: 'module'
    }])
  })

  it('uses the shared loader and private resource port for a pure ESM package graph', async () => {
    const config = JSON.stringify({
      plugins: [{ config: { label: 'fixture' }, id: 'permission', use: '@fixture/permission' }]
    })
    const entrySource = "import {value} from 'ordinary-dependency'; export default function plugin() { return value }"
    const graphRoot = 'holo-plugins:///permission/'
    const graphSources = new Map([
      [`${graphRoot}node_modules/@fixture/permission/package.json`, manifest],
      [`${graphRoot}node_modules/@fixture/permission/index.mjs`, entrySource],
      [
        `${graphRoot}node_modules/ordinary-dependency/package.json`,
        '{"name":"ordinary-dependency","type":"module","exports":"./index.mjs"}'
      ],
      [`${graphRoot}node_modules/ordinary-dependency/index.mjs`, 'export const value=42']
    ])
    const reader = Object.assign(recordingReader(config, [[entryPath, entrySource]]), {
      async openPrivateSourceRoot(selectedRoot: string, rootUrl: string, packageId?: string) {
        expect(selectedRoot).toBe(root)
        expect(rootUrl).toBe(graphRoot)
        expect(packageId).toBe('pinned-package')
        return { sourceRootId: 'selected-root', rootPath: root }
      },
      async readPrivateSourceResource(sourceRootId: string, url: string) {
        expect(sourceRootId).toBe('selected-root')
        const source = graphSources.get(url)
        if (source == null) return null
        const bytes = Buffer.from(source)
        return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), canonicalUrl: url }
      }
    })
    const prepared = await prepareHolonomyRuntimePluginsNative(configPath, { reader })
    expect(prepared.bundles[0]?.schemaVersion).toBe(2)
    const [bundle] = normalizeRuntimePluginBundlesV2(prepared.bundles)
    expect(bundle?.sourceClosure.reads.map(read => read.url)).toContain(
      `${graphRoot}node_modules/ordinary-dependency/package.json`
    )
    expect(bundle?.sourceClosure.reads.map(read => read.url)).toContain(
      `${graphRoot}node_modules/ordinary-dependency/index.mjs`
    )
    expect(bundle?.sourceClosure.externalReferences).toEqual([])
  })

  it('rejects a CommonJS package entry before producing an incomplete V1 bundle', async () => {
    const config = JSON.stringify({ plugins: [{ id: 'permission', use: '@fixture/permission' }] })
    const cjs = recordingReader(config, [
      [
        manifestPath,
        JSON.stringify({
          type: 'commonjs',
          holo: { apiVersion: 1, entry: './index.js', kind: 'runtime-plugin' }
        })
      ],
      [entryPath.replace('index.mjs', 'index.js'), "module.exports = require('ordinary-dependency')"]
    ])
    await expect(prepareHolonomyRuntimePluginsNative(configPath, { reader: cjs }))
      .rejects.toThrow('CommonJS graph is unsupported')
    expect(cjs.packageReads).toEqual([])
  })

  it('rejects a package-relative escape before reading its bytes', async () => {
    const config = JSON.stringify({
      plugins: [{ config: { label: 'fixture' }, id: 'permission', use: '@fixture/permission' }]
    })
    const escaping = recordingReader(config, [[
      entryPath,
      "import '../outside.mjs'; export default function plugin() {}"
    ]])
    await expect(prepareHolonomyRuntimePluginsNative(configPath, { reader: escaping }))
      .rejects.toThrow('escapes its source root')
    expect(escaping.packageReads.map(read => read.relativePath)).toEqual(['schema.json', 'index.mjs'])
  })

  it('never reads a package manifest as an executable module', async () => {
    const config = JSON.stringify({
      plugins: [{ config: { label: 'fixture' }, id: 'permission', use: '@fixture/permission' }]
    })
    const manifestEntry = recordingReader(config, [[
      manifestPath,
      JSON.stringify({
        holo: { apiVersion: 1, entry: './package.json', kind: 'runtime-plugin' }
      })
    ]])
    await expect(prepareHolonomyRuntimePluginsNative(configPath, { reader: manifestEntry }))
      .rejects.toThrow('manifest is not an executable module')
    expect(manifestEntry.packageReads).toEqual([])

    const manifestImport = recordingReader(config, [[
      entryPath,
      "import './package.json'; export default function plugin() {}"
    ]])
    await expect(prepareHolonomyRuntimePluginsNative(configPath, { reader: manifestImport }))
      .rejects.toThrow('manifest is not an executable module')
    expect(manifestImport.packageReads.some(read => read.relativePath === 'package.json')).toBe(false)
  })
})
