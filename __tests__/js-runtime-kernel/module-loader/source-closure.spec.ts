import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { HolonomyModuleLoader } from '../../../packages/runtime/src/module-loader/index.js'
import type {
  HolonomyModuleLoaderOptions,
  HostModuleLoaderPort,
  HostModuleSource
} from '../../../packages/runtime/src/module-loader/index.js'

const ROOT = 'app:///bundle/'
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const bytes = (value: string) => new TextEncoder().encode(value)
const packageJson = (value: Record<string, unknown>) => JSON.stringify(value)

const memoryLoader = (
  files: Record<string, string | Uint8Array>,
  options: Partial<HolonomyModuleLoaderOptions> = {}
) => {
  const sources = new Map(
    Object.entries(files).map(([name, value]) => [
      new URL(name, ROOT).toString(),
      typeof value === 'string' ? bytes(value) : value
    ])
  )
  const reads: string[] = []
  const port: HostModuleLoaderPort = {
    readModule(url) {
      reads.push(url)
      const source = sources.get(url)
      return source == null ? null : { bytes: source, sha256: digest(source) }
    },
    syntheticNodeModules: {}
  }
  return { loader: new HolonomyModuleLoader(port, { rootUrl: ROOT, ...options }), reads, sources }
}

const external = (specifier: string) =>
  specifier.startsWith('node:') || specifier.startsWith('holo:') || specifier === 'path'

describe('non-executable module source closure', () => {
  it('keeps executable plans and require cache usable with inherited kind pollution', async () => {
    const outcome = await (async () => {
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'kind')
      // eslint-disable-next-line no-extend-native -- intentional inherited-property regression
      Object.defineProperty(Object.prototype, 'kind', {
        configurable: true,
        value: 'opaque-external'
      })
      try {
        const { loader } = memoryLoader({
          'entry.cjs': "module.exports = require('./dependency.cjs')",
          'dependency.cjs': 'module.exports = 42',
          'external.mjs': "import 'node:fs'"
        })
        const plan = await loader.createPlan('./entry.cjs', { mode: 'require' })
        const requestFormat = loader.createRequire(`${ROOT}entry.cjs`)
          .request('./dependency.cjs').module.format
        const evaluationState = loader.beginEvaluation(`${ROOT}dependency.cjs`).state
        const resolved = await loader.resolve('./dependency.cjs', `${ROOT}entry.cjs`, 'require')
        const closure = await loader.createSourceClosure('./external.mjs', {
          isExternalModule: external
        })
        const repeated = await loader.createPlan('./entry.cjs', { mode: 'require' })
        const externalError: unknown = await loader.createPlan('./external.mjs').then(
          () => null,
          (error: unknown) => error
        )
        return { plan, requestFormat, evaluationState, resolved, closure, repeated, externalError }
      } finally {
        if (previous == null) {
          Reflect.deleteProperty(Object.prototype, 'kind')
        } else {
          // eslint-disable-next-line no-extend-native -- restore exact prior descriptor
          Object.defineProperty(Object.prototype, 'kind', previous)
        }
      }
    })()
    expect(outcome.plan.modules.map(module => module.url)).toEqual([
      `${ROOT}dependency.cjs`,
      `${ROOT}entry.cjs`
    ])
    expect(outcome.requestFormat).toBe('commonjs')
    expect(outcome.evaluationState).toBe('evaluating')
    expect(outcome.resolved).toBe(`${ROOT}dependency.cjs`)
    expect(outcome.closure.externalReferences[0]?.url).toBe('node:fs')
    expect('modules' in outcome.closure).toBe(false)
    expect(outcome.repeated.modules).toEqual(outcome.plan.modules)
    expect(outcome.externalError).toMatchObject({ code: 'ERR_HOLONOMY_MODULE_SYNTHETIC_NOT_FOUND' })
  })

  it('captures exact transitive source, package metadata, resolve-only targets, and opaque externals', async () => {
    const { loader, sources } = memoryLoader({
      'package.json': packageJson({
        name: 'closure-fixture',
        type: 'module',
        imports: { '#feature': './feature.mjs', '#core': 'path' }
      }),
      'entry.mjs': [
        "import '#feature'",
        "import '#core'",
        "import './cycle-a.mjs'",
        "import './data.json'",
        "import './uses-cjs.cjs'",
        "import 'node:fs'",
        "export const lazy = () => import('./lazy.mjs')"
      ].join('\n'),
      'feature.mjs': "import 'fixture-pkg'; export const feature = true",
      'uses-cjs.cjs': "require('fixture-pkg'); require.resolve('fixture-pkg/resolve-only'); require('holo:system')",
      'cycle-a.mjs': "import './cycle-b.mjs'; export const a = true",
      'cycle-b.mjs': "import './cycle-a.mjs'; export const b = true",
      'lazy.mjs': 'export const lazy = true',
      'data.json': '{"ready":true}',
      'node_modules/fixture-pkg/package.json': packageJson({
        name: 'fixture-pkg',
        exports: {
          '.': { import: './import.mjs', require: './require.cjs' },
          './resolve-only': './resolve-only.cjs'
        }
      }),
      'node_modules/fixture-pkg/import.mjs': 'export const imported = true',
      'node_modules/fixture-pkg/require.cjs': 'module.exports = true',
      'node_modules/fixture-pkg/resolve-only.cjs': 'module.exports = "not executed"'
    }, { allowJsonModules: true })

    const closure = await loader.createSourceClosure('./entry.mjs', { isExternalModule: external })
    expect(closure.kind).toBe('source-closure')
    expect(closure.entryUrl).toBe(`${ROOT}entry.mjs`)
    expect(closure.rootUrl).toBe(ROOT)
    expect('modules' in closure).toBe(false)
    expect(Object.isFrozen(closure)).toBe(true)
    expect(Object.isFrozen(closure.reads)).toBe(true)
    expect(Object.isFrozen(closure.externalReferences)).toBe(true)

    const readUrls = closure.reads.map(read => read.url)
    expect(readUrls).toEqual([...readUrls].sort())
    expect(readUrls).toContain(`${ROOT}package.json`)
    expect(readUrls).toContain(`${ROOT}node_modules/fixture-pkg/package.json`)
    expect(readUrls).toContain(`${ROOT}node_modules/fixture-pkg/import.mjs`)
    expect(readUrls).toContain(`${ROOT}node_modules/fixture-pkg/require.cjs`)
    expect(readUrls).toContain(`${ROOT}node_modules/fixture-pkg/resolve-only.cjs`)
    expect(readUrls).toContain(`${ROOT}lazy.mjs`)
    expect(readUrls).toContain(`${ROOT}cycle-a.mjs`)
    expect(readUrls).toContain(`${ROOT}cycle-b.mjs`)
    expect(readUrls).toContain(`${ROOT}data.json`)
    for (const read of closure.reads) {
      const original = sources.get(read.url)!
      expect(Object.isFrozen(read)).toBe(true)
      expect(Buffer.from(read.bytesBase64, 'base64')).toEqual(Buffer.from(original))
      expect(read.sha256).toBe(digest(original))
      expect(read.byteLength).toBe(original.byteLength)
    }
    expect(closure.externalReferences).toEqual(expect.arrayContaining([
      { kind: 'import', parentUrl: `${ROOT}entry.mjs`, specifier: '#core', url: 'node:path' },
      { kind: 'import', parentUrl: `${ROOT}entry.mjs`, specifier: 'node:fs', url: 'node:fs' },
      { kind: 'require', parentUrl: `${ROOT}uses-cjs.cjs`, specifier: 'holo:system', url: 'holo:system' }
    ]))
    expect(closure.externalReferences.every(Object.isFrozen)).toBe(true)

    // A successful closure cannot publish its opaque refs into an executable plan.
    await expect(loader.createPlan('./entry.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_NOT_FOUND'
    })
    await expect(loader.resolve('node:fs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_SYNTHETIC_NOT_FOUND'
    })
  })

  it('preserves physical fixture bytes and a literal dynamic import without enumerating resources', async () => {
    const fixtureRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      'fixtures/module-loader-f1/bundle'
    )
    const port: HostModuleLoaderPort = {
      readModule(url): HostModuleSource | null {
        const parsed = new URL(url)
        parsed.search = ''
        const name = decodeURIComponent(parsed.pathname.slice('/bundle/'.length))
          .replace(/^node_modules\//u, 'fixture-packages/')
          .replace('/dist/', '/compiled/')
        const path = join(fixtureRoot, name)
        if (!existsSync(path)) return null
        const source = readFileSync(path)
        return { bytes: source, sha256: digest(source) }
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    const closure = await loader.createSourceClosure('./entry.mjs', { isExternalModule: external })
    const entry = closure.reads.find(read => read.url === `${ROOT}entry.mjs`)
    expect(Buffer.from(entry!.bytesBase64, 'base64')).toEqual(readFileSync(join(fixtureRoot, 'entry.mjs')))
    expect(closure.reads.map(read => read.url)).toContain(`${ROOT}dynamic.mjs?revision=f1`)
    expect(closure.reads.map(read => read.url)).not.toContain(`${ROOT}resource.txt`)
    expect(closure.externalReferences.map(reference => reference.url)).toContain('node:path')
  })

  it('keeps verified byte copies stable when the Host mutates its input after return', async () => {
    const source = bytes('\uFEFFexport const value = true')
    const { loader } = memoryLoader({ 'entry.mjs': source })
    const closure = await loader.createSourceClosure('./entry.mjs', { isExternalModule: external })
    const copied = Buffer.from(closure.reads.find(read => read.url === `${ROOT}entry.mjs`)!.bytesBase64, 'base64')
    source.fill(0)
    expect(copied).toEqual(Buffer.from(bytes('\uFEFFexport const value = true')))
  })

  it('fails closed on missing externals and never turns classifier names into synthetic bindings', async () => {
    const { loader } = memoryLoader({ 'entry.mjs': "import 'node:unavailable'" })
    await expect(loader.createSourceClosure('./entry.mjs', {
      isExternalModule: () => false
    })).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_SYNTHETIC_NOT_FOUND' })
    const closure = await loader.createSourceClosure('./entry.mjs', {
      isExternalModule: specifier => specifier === 'node:unavailable'
    })
    expect(closure.externalReferences[0]?.url).toBe('node:unavailable')
    await expect(loader.createPlan('./entry.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_SYNTHETIC_NOT_FOUND'
    })
  })

  it('requires a positive read for an exact require.resolve target and retries after failure', async () => {
    const { loader, sources, reads } = memoryLoader({
      'entry.cjs': "require.resolve('fixture-pkg/only')",
      'node_modules/fixture-pkg/package.json': packageJson({
        exports: { './only': './only.cjs' }
      })
    })
    await expect(loader.createSourceClosure('./entry.cjs', { isExternalModule: external }))
      .rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_NOT_FOUND' })
    const url = `${ROOT}node_modules/fixture-pkg/only.cjs`
    sources.set(url, bytes('module.exports = 1'))
    const closure = await loader.createSourceClosure('./entry.cjs', { isExternalModule: external })
    expect(closure.reads.map(read => read.url)).toContain(url)
    expect(reads.filter(read => read === `${ROOT}entry.cjs`)).toHaveLength(2)
  })

  it('applies source and aggregate byte budgets to package metadata', async () => {
    const sources = {
      'package.json': packageJson({ type: 'module', imports: { '#local': './local.mjs' } }),
      'entry.mjs': "import '#local'",
      'local.mjs': 'export const ready = true'
    }
    const { loader } = memoryLoader(sources, {
      limits: { maxSourceBytes: 512, maxTotalSourceBytesPerPlan: bytes(sources['entry.mjs']).length + 1 }
    })
    await expect(loader.createSourceClosure('./entry.mjs', { isExternalModule: external }))
      .rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED' })
  })

  it('rejects the new API through both synchronous Host reentry and the read-context facade', async () => {
    let loader!: HolonomyModuleLoader
    let direct!: Promise<unknown>
    let facade!: Promise<unknown>
    const port: HostModuleLoaderPort = {
      readModule(url, context) {
        if (url !== `${ROOT}entry.mjs`) return null
        direct = loader.createSourceClosure('./entry.mjs', { isExternalModule: external })
        facade = context.loader.createSourceClosure('./entry.mjs', { isExternalModule: external })
        void direct.catch(() => {})
        void facade.catch(() => {})
        const source = bytes('export const ready = true')
        return { bytes: source, sha256: digest(source) }
      },
      syntheticNodeModules: {}
    }
    loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    await loader.createSourceClosure('./entry.mjs', { isExternalModule: external })
    await expect(direct).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_REENTRANT_HOST_CALL' })
    await expect(facade).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_REENTRANT_HOST_CALL' })
  })

  it('rejects a captured loader after an asynchronous Host read resumes', async () => {
    let loader!: HolonomyModuleLoader
    let reentered!: Promise<unknown>
    const port: HostModuleLoaderPort = {
      async readModule(url) {
        if (url !== `${ROOT}entry.mjs`) return null
        await Promise.resolve()
        reentered = loader.createSourceClosure('./entry.mjs', { isExternalModule: external })
        void reentered.catch(() => {})
        const source = bytes('export const ready = true')
        return { bytes: source, sha256: digest(source) }
      },
      syntheticNodeModules: {}
    }
    loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    await loader.createSourceClosure('./entry.mjs', { isExternalModule: external })
    await expect(reentered).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_REENTRANT_HOST_CALL' })
  })

  it('preserves a propagated captured-loader reentry error across the private closure reader', async () => {
    let loader!: HolonomyModuleLoader
    const port: HostModuleLoaderPort = {
      async readModule(url) {
        if (url !== `${ROOT}entry.mjs`) return null
        await Promise.resolve()
        await loader.createSourceClosure('./entry.mjs', { isExternalModule: external })
        return null
      },
      syntheticNodeModules: {}
    }
    loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    await expect(loader.createSourceClosure('./entry.mjs', { isExternalModule: external }))
      .rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_REENTRANT_HOST_CALL' })
  })
})
