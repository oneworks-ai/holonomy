import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { MobileModuleLoader, MobileModuleLoaderError, selectPluginActivate } from '../src/index.js'
import type { HostModuleLoaderPort, HostModuleSource, MobileModuleLoaderErrorCode, ModulePlan } from '../src/index.js'

const APP_ROOT = 'app:///bundle/'
const FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/module-loader-f1/bundle'
)

interface FixtureHostOptions {
  asyncRead?: boolean
  bytes?: Readonly<Record<string, Uint8Array>>
  claimedDigest?: Readonly<Record<string, string>>
  readError?: unknown
  sourceRecords?: Readonly<Record<string, unknown>>
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const createFixtureHost = (options: FixtureHostOptions = {}) => {
  const reads = new Map<string, number>()
  const readModule = (canonicalUrl: string): HostModuleSource | null => {
    if (options.readError != null) throw options.readError
    reads.set(canonicalUrl, (reads.get(canonicalUrl) ?? 0) + 1)
    if (Object.hasOwn(options.sourceRecords ?? {}, canonicalUrl)) {
      return options.sourceRecords?.[canonicalUrl] as HostModuleSource
    }
    const url = new URL(canonicalUrl)
    url.search = ''
    url.hash = ''
    const virtualPath = decodeURIComponent(url.pathname.slice('/bundle/'.length))
    const fixturePath = join(
      FIXTURE_ROOT,
      virtualPath
        .replace(/^node_modules\//u, 'fixture-packages/')
        .replace('/dist/', '/compiled/')
    )
    const override = options.bytes?.[canonicalUrl]
    if (override == null && !existsSync(fixturePath)) return null
    const fileBytes = override ?? readFileSync(fixturePath)
    const bytes = new Uint8Array(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength)
    return {
      bytes,
      sha256: options.claimedDigest?.[canonicalUrl] ?? digest(bytes)
    }
  }
  const port: HostModuleLoaderPort = {
    readModule(canonicalUrl) {
      return options.asyncRead === true
        ? Promise.resolve().then(() => readModule(canonicalUrl))
        : readModule(canonicalUrl)
    },
    syntheticNodeModules: {
      'node:path': { exportNames: ['default', 'join'] }
    }
  }
  return { port, reads }
}

const createLoader = (
  options: Omit<ConstructorParameters<typeof MobileModuleLoader>[1], 'rootUrl'> = {},
  hostOptions: FixtureHostOptions = {}
) => {
  const host = createFixtureHost(hostOptions)
  return {
    ...host,
    loader: new MobileModuleLoader(host.port, { rootUrl: APP_ROOT, ...options })
  }
}

const expectLoaderError = async (
  operation: () => unknown | Promise<unknown>,
  code: MobileModuleLoaderErrorCode
) => {
  let thrown: unknown
  try {
    await operation()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(MobileModuleLoaderError)
  expect(thrown).toMatchObject({ code })
  return thrown as MobileModuleLoaderError
}

const moduleBySuffix = (plan: ModulePlan, suffix: string) => {
  const module = plan.modules.find(candidate => candidate.url.endsWith(suffix))
  expect(module, `missing planned module ${suffix}`).toBeDefined()
  return module!
}

describe('mobileModuleLoader F1 module plan', () => {
  it('builds a deterministic, integrity-verified ESM/CJS graph with cycles and dynamic query identity', async () => {
    const { loader, reads } = createLoader()
    const first = await loader.createPlan('./entry.mjs')
    const readsAfterFirstPlan = new Map(reads)
    const second = await loader.createPlan('./entry.mjs')

    expect(second).toEqual(first)
    expect(reads).toEqual(readsAfterFirstPlan)
    expect(first.entryUrl).toBe('app:///bundle/entry.mjs')
    expect(first.modules.map(module => module.url)).toEqual(
      [...first.modules.map(module => module.url)].sort()
    )
    expect(first.modules.map(module => module.url)).toEqual(expect.arrayContaining([
      'app:///bundle/cycle-a.mjs',
      'app:///bundle/cycle-b.mjs',
      'app:///bundle/dynamic.mjs?revision=f1',
      'app:///bundle/entry.mjs',
      'app:///bundle/node_modules/@fixture/f1-runtime/dist/import-plugin.mjs',
      'app:///bundle/node_modules/@fixture/f1-runtime/dist/named-plugin.js',
      'app:///bundle/node_modules/@fixture/f1-runtime/dist/peer.cjs',
      'app:///bundle/node_modules/@fixture/f1-runtime/dist/plugin.cjs',
      'app:///bundle/runtime-dynamic.mjs',
      'node:path'
    ]))
    expect(first.modules.some(module => module.url.includes('/source/'))).toBe(false)

    const entry = moduleBySuffix(first, '/entry.mjs')
    expect(entry.format).toBe('module')
    expect(entry.exportNames).toEqual(expect.arrayContaining([
      'activatePlugin',
      'cjsPlugin',
      'defaultPlugin',
      'loadDynamic',
      'resourceUrl'
    ]))
    expect(entry.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        interop: 'commonjs-namespace',
        resolvedUrl: 'app:///bundle/node_modules/@fixture/f1-runtime/dist/plugin.cjs',
        specifier: '@fixture/f1-runtime/cjs'
      }),
      expect.objectContaining({
        interop: 'synthetic-namespace',
        resolvedUrl: 'node:path'
      }),
      expect.objectContaining({
        kind: 'dynamic-import',
        resolvedUrl: 'app:///bundle/dynamic.mjs?revision=f1'
      })
    ]))

    const defaultPlugin = moduleBySuffix(first, '/dist/import-plugin.mjs')
    const namedPlugin = moduleBySuffix(first, '/dist/named-plugin.js')
    const commonJsPlugin = moduleBySuffix(first, '/dist/plugin.cjs')
    const runtimeDynamic = moduleBySuffix(first, '/runtime-dynamic.mjs')
    expect(defaultPlugin.exportNames).toContain('default')
    expect(namedPlugin.exportNames).toContain('activatePlugin')
    expect(commonJsPlugin.exportNames).toEqual(expect.arrayContaining([
      'activatePlugin',
      'default',
      'peer',
      'resolvedPeer'
    ]))
    expect(runtimeDynamic.dependencies).toEqual([{
      interop: null,
      kind: 'dynamic-import',
      resolvedUrl: null,
      specifier: null
    }])
    expect(first.modules.some(module => module.url.includes('ignored.mjs'))).toBe(false)

    const cycleA = moduleBySuffix(first, '/cycle-a.mjs')
    const cycleB = moduleBySuffix(first, '/cycle-b.mjs')
    expect(cycleA.dependencies[0]?.resolvedUrl).toBe(cycleB.url)
    expect(cycleB.dependencies[0]?.resolvedUrl).toBe(cycleA.url)
    expect(first.modules.every(module => module.sha256 == null || /^[\da-f]{64}$/u.test(module.sha256))).toBe(true)
    expect(await loader.load(first.entryUrl)).toEqual(entry)
  })

  it('keeps query cache-busters as distinct canonical module identities', async () => {
    const { loader, reads } = createLoader()
    const first = await loader.createPlan('./dynamic.mjs?revision=one')
    const second = await loader.createPlan('./dynamic.mjs?revision=two')

    expect(first.entryUrl).toBe('app:///bundle/dynamic.mjs?revision=one')
    expect(second.entryUrl).toBe('app:///bundle/dynamic.mjs?revision=two')
    expect(reads.get(first.entryUrl)).toBe(1)
    expect(reads.get(second.entryUrl)).toBe(1)
  })

  it('uses production conditions by default and enables source conditions only explicitly', async () => {
    const productionLoader = createLoader().loader
    expect((await productionLoader.resolve('@fixture/f1-runtime')).endsWith('/dist/import-plugin.mjs')).toBe(true)
    expect((await productionLoader.resolve('@fixture/f1-runtime/module-only')).endsWith('/dist/module-plugin.mjs'))
      .toBe(true)
    expect((await productionLoader.resolve('@fixture/f1-runtime/default-only')).endsWith('/dist/default-plugin.mjs'))
      .toBe(true)

    const sourceLoader = createLoader({ resolutionProfile: 'source' }).loader
    expect((await sourceLoader.resolve('@fixture/f1-runtime')).endsWith('/source/default-plugin.mjs')).toBe(true)
    expect(
      (await productionLoader.resolve('@fixture/f1-runtime/cjs', undefined, 'require')).endsWith('/dist/plugin.cjs')
    ).toBe(true)
  })

  it('resolves file-like resource URLs without adding them to the module graph', async () => {
    const { loader } = createLoader()
    const resourceUrl = loader.resolveResource(
      './resource.txt?variant=dark#icon',
      'app:///bundle/entry.mjs'
    )
    const plan = await loader.createPlan('./entry.mjs')

    expect(resourceUrl).toBe('app:///bundle/resource.txt?variant=dark#icon')
    expect(plan.modules.some(module => module.url.includes('resource.txt'))).toBe(false)
  })
})

describe('mobileModuleLoader controlled CommonJS contract', () => {
  it('supports createRequire resolution, CJS cycles and enumerable/deletable require.cache state', async () => {
    const { loader } = createLoader()
    const plan = await loader.createPlan('@fixture/f1-runtime/cjs', { mode: 'require' })
    const plugin = moduleBySuffix(plan, '/dist/plugin.cjs')
    const peer = moduleBySuffix(plan, '/dist/peer.cjs')
    const moduleRequire = loader.createRequire(plugin.url)

    expect(moduleRequire.resolve('./peer.cjs')).toBe(peer.url)
    expect(moduleRequire.request('./peer.cjs')).toMatchObject({
      cached: undefined,
      module: { format: 'commonjs', url: peer.url },
      url: peer.url
    })

    const partialPluginExports = { phase: 'partial' }
    const evaluating = loader.beginEvaluation(plugin.url, partialPluginExports)
    expect(loader.beginEvaluation(plugin.url, { ignored: true })).toBe(evaluating)
    loader.beginEvaluation(peer.url, { peer: true })
    expect(moduleRequire.cache.keys()).toEqual([peer.url, plugin.url].sort())
    expect(moduleRequire.cache.get(plugin.url)?.exports).toBe(partialPluginExports)

    loader.completeEvaluation(peer.url, { peer: 'complete' })
    loader.completeEvaluation(plugin.url, { activatePlugin: () => 'complete' })
    expect(moduleRequire.request('./peer.cjs').cached?.state).toBe('evaluated')
    expect(moduleRequire.cache.delete(plugin.url)).toBe(true)
    expect(moduleRequire.cache.get(plugin.url)).toBeUndefined()
    expect(moduleRequire.cache.delete(plugin.url)).toBe(false)
  })

  it('exposes CJS default/named interop and rejects require of ESM', async () => {
    const { loader } = createLoader()
    const plan = await loader.createPlan('@fixture/f1-runtime/cjs', { mode: 'require' })
    const plugin = moduleBySuffix(plan, '/dist/plugin.cjs')

    expect(plugin.exportNames).toEqual(expect.arrayContaining(['default', 'activatePlugin']))
    await expectLoaderError(
      () => loader.createPlan('./esm-require.cjs', { mode: 'require' }),
      'ERR_REQUIRE_ESM'
    )
  })
})

describe('mobileModuleLoader security and entry boundaries', () => {
  it('fails closed on traversal, unknown schemes, fragments and unknown synthetics', async () => {
    const { loader } = createLoader()
    await expectLoaderError(
      () => loader.resolve('../../outside.mjs', 'app:///bundle/nested/entry.mjs'),
      'ERR_MOBILE_MODULE_PATH_ESCAPE'
    )
    await expectLoaderError(
      () => loader.resolve('https://example.com/module.mjs'),
      'ERR_MOBILE_MODULE_UNSUPPORTED_SCHEME'
    )
    await expectLoaderError(
      () => loader.resolve('./entry.mjs#fragment'),
      'ERR_MOBILE_MODULE_INVALID_URL'
    )
    await expectLoaderError(
      () => loader.resolve('node:fs'),
      'ERR_MOBILE_MODULE_SYNTHETIC_NOT_FOUND'
    )
    await expectLoaderError(
      () => loader.resolve('@fixture/f1-runtime/private'),
      'ERR_PACKAGE_PATH_NOT_EXPORTED'
    )
  })

  it('recomputes host integrity, rejects digest aliases and enforces a trusted manifest', async () => {
    const canonicalEntry = 'app:///bundle/entry.mjs'
    const hostMismatch = createLoader({}, {
      claimedDigest: { [canonicalEntry]: '0'.repeat(64) }
    }).loader
    await expectLoaderError(
      () => hostMismatch.createPlan('./entry.mjs'),
      'ERR_MOBILE_MODULE_INTEGRITY'
    )

    const entryBytes = readFileSync(join(FIXTURE_ROOT, 'entry.mjs'))
    const digestAlias = createLoader({}, {
      claimedDigest: { [canonicalEntry]: `sha256:${digest(entryBytes)}` }
    }).loader
    await expectLoaderError(
      () => digestAlias.createPlan('./entry.mjs'),
      'ERR_MOBILE_MODULE_INTEGRITY'
    )

    const manifestMismatch = createLoader({
      integrity: { [canonicalEntry]: 'f'.repeat(64) }
    }).loader
    await expectLoaderError(
      () => manifestMismatch.createPlan('./entry.mjs'),
      'ERR_MOBILE_MODULE_INTEGRITY'
    )
  })

  it('accepts only verified bytes and decodes UTF-8 strictly', async () => {
    const canonicalEntry = 'app:///bundle/entry.mjs'
    const invalidUtf8 = new Uint8Array([0xED, 0xA0, 0x80])
    const invalidBytesLoader = createLoader({}, {
      bytes: { [canonicalEntry]: invalidUtf8 }
    }).loader
    await expectLoaderError(
      () => invalidBytesLoader.createPlan('./entry.mjs'),
      'ERR_MOBILE_MODULE_SOURCE_INVALID'
    )

    const stringRecordLoader = createLoader({}, {
      sourceRecords: {
        [canonicalEntry]: { sha256: '0'.repeat(64), source: '\uD800' }
      }
    }).loader
    await expectLoaderError(
      () => stringRecordLoader.createPlan('./entry.mjs'),
      'ERR_MOBILE_MODULE_SOURCE_INVALID'
    )
  })

  it('sanitizes synchronous and asynchronous host read failures', async () => {
    for (const asyncRead of [false, true]) {
      const loader = createLoader({}, {
        asyncRead,
        readError: new Error('ENOENT /private/native/plugin-secret.mjs')
      }).loader
      const error = await expectLoaderError(
        () => loader.createPlan('./entry.mjs'),
        'ERR_MOBILE_MODULE_HOST_READ_FAILED'
      )
      expect(error).toMatchObject({ diagnosticCode: 'HOST_READ_FAILED' })
      expect(error.message).not.toContain('ENOENT')
      expect(error.message).not.toContain('/private/native')
      expect(Object.hasOwn(error, 'cause')).toBe(false)
      expect(JSON.stringify(error)).not.toContain('plugin-secret')
    }
  })

  it('fails closed on TypeScript, unknown extensions and disabled JSON', async () => {
    const { loader } = createLoader()
    for (
      const specifier of [
        '@fixture/f1-runtime/typescript',
        '@fixture/f1-runtime/tsx',
        './resource.txt'
      ]
    ) {
      await expectLoaderError(
        () => loader.createPlan(specifier),
        'ERR_MOBILE_MODULE_FORMAT_UNSUPPORTED'
      )
    }
    await expectLoaderError(
      () => loader.createPlan('./fixture.json'),
      'ERR_MOBILE_MODULE_JSON_UNSUPPORTED'
    )
  })

  it('rejects native addons, dlopen and non-literal CommonJS require', async () => {
    const { loader } = createLoader()
    await expectLoaderError(
      () => loader.createPlan('./native.cjs', { mode: 'require' }),
      'ERR_MOBILE_MODULE_NATIVE_ADDON_UNSUPPORTED'
    )
    await expectLoaderError(
      () => loader.createPlan('./dlopen.cjs', { mode: 'require' }),
      'ERR_MOBILE_MODULE_NATIVE_ADDON_UNSUPPORTED'
    )
    await expectLoaderError(
      () => loader.createPlan('./dynamic-require.cjs', { mode: 'require' }),
      'ERR_MOBILE_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED'
    )
  })

  it('selects only named activatePlugin or default.activatePlugin entry shapes', async () => {
    const named = () => 'named'
    const nested = () => 'default'

    expect(selectPluginActivate({ activatePlugin: named })).toBe(named)
    expect(selectPluginActivate({ default: { activatePlugin: nested } })).toBe(nested)
    await expectLoaderError(
      () => selectPluginActivate({ default: () => undefined }),
      'ERR_MOBILE_MODULE_PLUGIN_ENTRY_INVALID'
    )
  })
})

describe('module-loader fixture containment', () => {
  it('keeps every host read inside the real F1 fixture root', async () => {
    const { loader, reads } = createLoader()
    await loader.createPlan('./entry.mjs')
    for (const url of reads.keys()) {
      const pathname = decodeURIComponent(new URL(url).pathname.slice('/bundle/'.length))
      expect(relative(FIXTURE_ROOT, join(FIXTURE_ROOT, pathname))).not.toMatch(/^\.\.(?:\/|$)/u)
    }
  })
})
