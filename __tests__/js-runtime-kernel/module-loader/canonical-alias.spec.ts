import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { HolonomyModuleLoader } from '../../../packages/runtime/src/module-loader/index.js'
import type { HostModuleLoaderPort, HostModuleSource } from '../../../packages/runtime/src/module-loader/index.js'

const ROOT = 'app:///bundle/'
const STRIP = `${ROOT}node_modules/.pnpm/strip-ansi@6.0.1/node_modules/strip-ansi/`
const REGEX = `${ROOT}node_modules/.pnpm/ansi-regex@5.0.1/node_modules/ansi-regex/`
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const source = (value: string, canonicalUrl?: string): HostModuleSource => {
  const bytes = new TextEncoder().encode(value)
  return { bytes, canonicalUrl, sha256: digest(bytes) }
}

const pnpmPort = () => {
  const sources = new Map<string, string>([
    [`${ROOT}entry.mjs`, "import 'strip-ansi'; import 'alias-strip'"],
    [
      `${STRIP}package.json`,
      JSON.stringify({
        name: 'strip-ansi',
        type: 'module',
        exports: { '.': './index.js', './util': './util.js' },
        imports: { '#local': './local.js' }
      })
    ],
    [`${STRIP}index.js`, "import 'ansi-regex'; import '#local'; import 'strip-ansi/util'; export const marker = 1"],
    [`${STRIP}local.js`, 'export const local = true'],
    [`${STRIP}util.js`, 'export const util = true'],
    [
      `${REGEX}package.json`,
      JSON.stringify({
        name: 'ansi-regex',
        type: 'module',
        exports: { '.': './index.js' }
      })
    ],
    [`${REGEX}index.js`, 'export const regex = true']
  ])
  const requests: string[] = []
  const aliases = [
    [`${ROOT}node_modules/strip-ansi/`, STRIP],
    [`${ROOT}node_modules/alias-strip/`, STRIP],
    [`${ROOT}node_modules/.pnpm/strip-ansi@6.0.1/node_modules/ansi-regex/`, REGEX]
  ] as const
  const port: HostModuleLoaderPort = {
    readModule(url) {
      requests.push(url)
      const alias = aliases.find(([prefix]) => url.startsWith(prefix))
      const canonicalUrl = alias == null ? url : alias[1] + url.slice(alias[0].length)
      const fileUrl = new URL(canonicalUrl)
      fileUrl.search = ''
      const text = sources.get(fileUrl.toString())
      return text == null ? null : source(text, canonicalUrl)
    },
    syntheticNodeModules: {}
  }
  return { port, requests }
}

describe('host canonical module identity', () => {
  it('plans pnpm transitive packages, imports, exports and self references once', async () => {
    const { port } = pnpmPort()
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    const plan = await loader.createPlan('./entry.mjs')
    const urls = plan.modules.map(module => module.url)
    expect(urls).toContain(`${STRIP}index.js`)
    expect(urls).toContain(`${REGEX}index.js`)
    expect(urls).toContain(`${STRIP}local.js`)
    expect(urls).toContain(`${STRIP}util.js`)
    expect(urls.filter(url => url === `${STRIP}index.js`)).toHaveLength(1)
    expect(urls.some(url => url.includes('/node_modules/alias-strip/'))).toBe(false)
    expect(await loader.resolve('strip-ansi')).toBe(`${STRIP}index.js`)
    expect(await loader.resolve('alias-strip')).toBe(`${STRIP}index.js`)
    expect(plan.modules.find(module => module.url === `${STRIP}index.js`)?.format).toBe('module')
  })

  it('shares the CommonJS evaluation cache across two package aliases', async () => {
    const real = `${ROOT}node_modules/.pnpm/common@1/node_modules/common/`
    const requests: string[] = []
    const port: HostModuleLoaderPort = {
      readModule(url) {
        requests.push(url)
        if (url === `${ROOT}entry.cjs`) return source("require('left'); require('right')")
        for (const name of ['left', 'right']) {
          if (url === `${ROOT}node_modules/${name}/package.json`) {
            return source('{"name":"common","exports":"./index.cjs"}', `${real}package.json`)
          }
        }
        if (url === `${real}index.cjs`) return source('module.exports = 42')
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    const plan = await loader.createPlan('./entry.cjs', { mode: 'require' })
    expect(plan.modules.filter(module => module.url === `${real}index.cjs`)).toHaveLength(1)
    const require = loader.createRequire(`${ROOT}entry.cjs`)
    const left = require.request('left')
    const right = require.request('right')
    expect(left.url).toBe(right.url)
    const evaluating = loader.beginEvaluation(left.url)
    expect(require.cache.get(right.url)).toBe(evaluating)
    loader.completeEvaluation(right.url, 42)
    expect(require.request('left').cached?.exports).toBe(42)
    expect(requests).toContain(`${ROOT}node_modules/right/package.json`)
  })

  it('emits only canonical positive reads and flat frozen aliases in the closure', async () => {
    const { port } = pnpmPort()
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    const closure = await loader.createSourceClosure('./entry.mjs', { isExternalModule: () => false })
    const reads = closure.reads.map(read => read.url)
    expect(reads).toContain(`${STRIP}package.json`)
    expect(reads).toContain(`${REGEX}index.js`)
    expect(reads.filter(url => url === `${STRIP}package.json`)).toHaveLength(1)
    expect(reads.some(url => url.includes('/node_modules/alias-strip/'))).toBe(false)
    expect(closure.aliases).toContainEqual({
      url: `${ROOT}node_modules/strip-ansi/package.json`,
      canonicalUrl: `${STRIP}package.json`
    })
    expect(closure.aliases).toContainEqual({
      url: `${ROOT}node_modules/alias-strip/package.json`,
      canonicalUrl: `${STRIP}package.json`
    })
    expect(Object.isFrozen(closure.aliases)).toBe(true)
    expect(closure.aliases.every(alias => Object.isFrozen(alias))).toBe(true)
    expect(closure.aliases.every(alias => reads.includes(alias.canonicalUrl))).toBe(true)
    expect(closure.aliases.every(alias => !closure.aliases.some(other => other.url === alias.canonicalUrl)))
      .toBe(true)
    const strip = closure.reads.find(read => read.url === `${STRIP}index.js`)!
    expect(digest(Buffer.from(strip.bytesBase64, 'base64'))).toBe(strip.sha256)
  })

  it('canonicalizes the positive read for a resolve-only target', async () => {
    const canonicalUrl = `${ROOT}physical/target.cjs`
    const port: HostModuleLoaderPort = {
      readModule(url) {
        if (url === `${ROOT}entry.cjs`) return source("require.resolve('./alias.cjs')")
        if (url === `${ROOT}alias.cjs`) return source('module.exports = 1', canonicalUrl)
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    const closure = await loader.createSourceClosure('./entry.cjs', {
      isExternalModule: () => false,
      mode: 'require'
    })
    expect(closure.reads.map(read => read.url)).toContain(canonicalUrl)
    expect(closure.reads.map(read => read.url)).not.toContain(`${ROOT}alias.cjs`)
    expect(closure.aliases).toContainEqual({ url: `${ROOT}alias.cjs`, canonicalUrl })
  })

  it('preserves the query while coalescing two requested aliases', async () => {
    const { port } = pnpmPort()
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    const first = await loader.resolve('./node_modules/strip-ansi/index.js?revision=1')
    const second = await loader.resolve('./node_modules/alias-strip/index.js?revision=1')
    const third = await loader.resolve('./node_modules/strip-ansi/index.js?revision=2')
    expect(first).toBe(`${STRIP}index.js?revision=1`)
    expect(second).toBe(first)
    expect(third).toBe(`${STRIP}index.js?revision=2`)
    const plan = await loader.createPlan('./node_modules/alias-strip/index.js?revision=1')
    expect(plan.entryUrl).toBe(first)
    expect(plan.modules.filter(module => module.url === first)).toHaveLength(1)
  })

  it('preserves an existing empty fragment without admitting a new fragment', async () => {
    const port: HostModuleLoaderPort = {
      readModule: () => source('export const value = 1', `${ROOT}real.mjs?revision=1#`),
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    expect(await loader.resolve('./alias.mjs?revision=1#')).toBe(`${ROOT}real.mjs?revision=1#`)
    await expect(loader.resolve('./alias.mjs?revision=1')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_SOURCE_INVALID'
    })
  })

  it('preserves an existing empty query delimiter', async () => {
    const port: HostModuleLoaderPort = {
      readModule: () => source('export const value = 1', `${ROOT}real.mjs?`),
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    expect(await loader.resolve('./alias.mjs?')).toBe(`${ROOT}real.mjs?`)
    await expect(loader.resolve('./alias.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_SOURCE_INVALID'
    })
  })

  it.each([
    './relative.mjs',
    'app:///outside/entry.mjs',
    `${ROOT}real.mjs#fragment`,
    `${ROOT}real.mjs?wrong=1`,
    `${ROOT}nested/../real.mjs?revision=1`,
    'node:fs'
  ])('rejects invalid Host canonical URL %s', async canonicalUrl => {
    const port: HostModuleLoaderPort = {
      readModule: () => source('export const value = 1', canonicalUrl),
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    await expect(loader.createPlan('./entry.mjs?revision=1')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_SOURCE_INVALID'
    })
  })

  it('rejects a conflicting digest from another alias of a cached canonical source', async () => {
    let conflicting = true
    const canonicalUrl = `${ROOT}real.mjs`
    const port: HostModuleLoaderPort = {
      readModule(url) {
        if (url === `${ROOT}a.mjs`) return source('export const value = 1', canonicalUrl)
        if (url === `${ROOT}b.mjs`) {
          return source(conflicting ? 'export const value = 2' : 'export const value = 1', canonicalUrl)
        }
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    expect(await loader.resolve('./a.mjs')).toBe(canonicalUrl)
    await expect(loader.resolve('./b.mjs')).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_INTEGRITY' })
    conflicting = false
    expect(await loader.resolve('./b.mjs')).toBe(canonicalUrl)
  })

  it('applies trusted integrity to the canonical target and rejects alias chains', async () => {
    const canonicalUrl = `${ROOT}real.mjs`
    const port: HostModuleLoaderPort = {
      readModule(url) {
        if (url === `${ROOT}a.mjs`) return source('export const value = 1', canonicalUrl)
        if (url === `${ROOT}b.mjs`) return source('export const value = 1', `${ROOT}a.mjs`)
        return null
      },
      syntheticNodeModules: {}
    }
    const rejectedIntegrity = new HolonomyModuleLoader(port, {
      rootUrl: ROOT,
      integrity: { [canonicalUrl]: '0'.repeat(64) }
    })
    await expect(rejectedIntegrity.resolve('./a.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_INTEGRITY'
    })
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    await loader.resolve('./a.mjs')
    await expect(loader.resolve('./b.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_SOURCE_INVALID'
    })
  })

  it('bounds positive alias admissions independently of canonical module count', async () => {
    const entry = Array.from({ length: 513 }, (_, index) => `import './alias-${index}.mjs'`).join('\n')
    const port: HostModuleLoaderPort = {
      readModule(url) {
        if (url === `${ROOT}entry.mjs`) return source(entry)
        if (url.startsWith(`${ROOT}alias-`)) {
          return source('export const value = 1', `${ROOT}physical/shared.mjs`)
        }
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    await expect(loader.createSourceClosure('./entry.mjs', { isExternalModule: () => false }))
      .rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED' })
  })

  it('bounds persistent aliases across separate successful plan transactions', async () => {
    const canonicalUrl = `${ROOT}physical.mjs`
    const loader = new HolonomyModuleLoader({
      readModule: url => url.endsWith('.mjs') ? source('export const value = 1', canonicalUrl) : null,
      syntheticNodeModules: {}
    }, { rootUrl: ROOT })
    for (let index = 0; index < 512; index++) {
      expect((await loader.createPlan(`./alias-${index}.mjs`)).entryUrl).toBe(canonicalUrl)
    }
    await expect(loader.createPlan('./alias-512.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    })
    expect((await loader.createPlan('./alias-0.mjs')).entryUrl).toBe(canonicalUrl)
    expect((await loader.createPlan(canonicalUrl)).entryUrl).toBe(canonicalUrl)
  })

  it('rolls back aliases and canonical source after a failed graph transaction', async () => {
    let dependencyPresent = false
    const requests: string[] = []
    const port: HostModuleLoaderPort = {
      readModule(url) {
        requests.push(url)
        if (url === `${ROOT}entry.mjs`) {
          return source("import './missing.mjs'", `${ROOT}physical/entry.mjs`)
        }
        if (url === `${ROOT}physical/missing.mjs` && dependencyPresent) {
          return source('export const ready = true')
        }
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    await expect(loader.createPlan('./entry.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_NOT_FOUND'
    })
    dependencyPresent = true
    const plan = await loader.createPlan('./entry.mjs')
    expect(plan.entryUrl).toBe(`${ROOT}physical/entry.mjs`)
    expect(requests.filter(url => url === `${ROOT}entry.mjs`)).toHaveLength(2)
  })

  it('rejects a canonical package manifest with a non-manifest filename', async () => {
    const port: HostModuleLoaderPort = {
      readModule(url) {
        return url === `${ROOT}node_modules/linked/package.json`
          ? source('{"name":"linked","exports":"./index.mjs"}', `${ROOT}physical/not-package.json`)
          : null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    await expect(loader.resolve('linked')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_INVALID_PACKAGE_CONFIG'
    })
  })

  it('does not admit a Host canonical native-addon target through a JavaScript alias', async () => {
    const port: HostModuleLoaderPort = {
      readModule: () => source('export const value = 1', `${ROOT}native.node`),
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    await expect(loader.resolve('./entry.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_NATIVE_ADDON_UNSUPPORTED'
    })
  })
})
