import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { it as test } from 'vitest'

import {
  normalizeRuntimePluginBundlesV2,
  runtimePluginBundleDigestV2
} from '../../../../packages/runtime/src/app/plugin-bundle-v2.ts'
import { HolonomyModuleLoader } from '../../../../packages/runtime/src/module-loader/index.ts'
import { RuntimeURL } from '../../../node/src/runtime-web-standards.mjs'
import { createNativePluginHost } from '../bootstrap/plugins.mjs'

const rootUrl = 'holo-plugins:///graph/'
const entryUrl = `${rootUrl}host/gate.mjs`
const canonicalDep = `${rootUrl}node_modules/.pnpm/dep@1/node_modules/dep/`
const sources = new Map([
  [`${rootUrl}host/package.json`, '{"type":"module"}'],
  [
    entryUrl,
    "import * as a from 'dep'; import * as b from 'dep-alias'; globalThis.__nativePluginV2Evaluated=true; if(a!==b)throw Error('alias'); export default function gate(){}"
  ],
  [`${canonicalDep}package.json`, '{"name":"dep","type":"module","exports":"./index.mjs"}'],
  [`${canonicalDep}index.mjs`, 'export const singleton = {}']
])
const aliases = [
  [`${rootUrl}node_modules/dep/`, canonicalDep],
  [`${rootUrl}node_modules/dep-alias/`, canonicalDep]
]
const resource = url => {
  const alias = aliases.find(([requested]) => url.startsWith(requested))
  const canonicalUrl = alias == null ? url : alias[1] + url.slice(alias[0].length)
  const source = sources.get(canonicalUrl)
  if (source == null) return null
  const bytes = Buffer.from(source)
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), canonicalUrl }
}

test('host V2 preflight pins a canonical package plan before user execution', async () => {
  const loader = new HolonomyModuleLoader({ readModule: resource, syntheticNodeModules: {} }, { rootUrl })
  const sourceClosure = await loader.createSourceClosure(entryUrl, { isExternalModule: () => false })
  const raw = {
    config: {},
    entryUrl,
    exportName: 'default',
    instanceId: 'graph',
    rootUrl,
    schemaVersion: 2,
    sourceClosure
  }
  const digest = runtimePluginBundleDigestV2(raw)
  const calls = []
  const native = {
    pluginSourceResource(url, purpose) {
      calls.push(['read', url, purpose])
      const selected = resource(url)
      return selected == null ? null : JSON.stringify({
        bytes: [...selected.bytes],
        sha256: selected.sha256,
        canonicalUrl: selected.canonicalUrl
      })
    },
    pluginPlan(encoded, value) {
      calls.push(['plan', JSON.parse(encoded), value])
      return `${entryUrl}?holo-bundle=${value}`
    },
    pluginGraphRelease(entry) {
      calls.push(['release', entry])
    }
  }
  const manager = createNativePluginHost(native, {}, {})
  await manager.prepareHostPlugins([{
    config: {},
    configSchema: null,
    entryUrl,
    exportName: 'default',
    instanceId: 'graph',
    integrity: digest,
    rootUrl,
    resourceGraph: { schemaVersion: 2, rootUrl, entryUrl, required: true }
  }])
  const plan = calls.find(call => call[0] === 'plan')?.[1]
  assert(plan)
  assert.equal(plan.modules.filter(module => module.url === `${canonicalDep}index.mjs`).length, 1)
  assert.equal(calls.filter(call => call[0] === 'plan').length, 1)
  const reads = calls.filter(call => call[0] === 'read')
  assert(reads.some(([, url, purpose]) => url === entryUrl && purpose === 'module'))
  assert(reads.some(([, url, purpose]) => url.endsWith('/package.json') && purpose === 'packageMetadata'))
  assert(reads.every(([, url, purpose]) => purpose === (url.endsWith('/package.json') ? 'packageMetadata' : 'module')))
  assert.equal(globalThis.__nativePluginV2Evaluated, undefined)
  await manager.close()
  assert.deepEqual(calls.at(-1), ['release', `${entryUrl}?holo-bundle=${digest}`])
})

test('optional standalone resource graph upgrades on a bare import without changing its V1 entry', async () => {
  const loader = new HolonomyModuleLoader({ readModule: resource, syntheticNodeModules: {} }, { rootUrl })
  const sourceClosure = await loader.createSourceClosure(entryUrl, { isExternalModule: () => false })
  const raw = {
    config: {},
    entryUrl,
    exportName: 'default',
    instanceId: 'graph',
    rootUrl,
    schemaVersion: 2,
    sourceClosure
  }
  const digest = runtimePluginBundleDigestV2(raw)
  const legacyReads = []
  const resourceReads = []
  const native = {
    pluginSource(url, purpose) {
      legacyReads.push([url, purpose])
      const selected = resource(url)
      return selected == null ? null : JSON.stringify({ bytes: [...selected.bytes], sha256: selected.sha256 })
    },
    pluginSourceResource(url, purpose) {
      resourceReads.push([url, purpose])
      const selected = resource(url)
      return selected == null ? null : JSON.stringify({
        bytes: [...selected.bytes],
        sha256: selected.sha256,
        canonicalUrl: selected.canonicalUrl
      })
    },
    pluginPlan(_encoded, value) {
      return `${entryUrl}?holo-bundle=${value}`
    },
    pluginGraphRelease() {}
  }
  const manager = createNativePluginHost(native, {}, {})
  await manager.prepareHostPlugins([{
    config: {},
    configSchema: null,
    entryUrl,
    exportName: 'default',
    instanceId: 'graph',
    integrity: digest,
    rootUrl,
    resourceGraph: { schemaVersion: 2, rootUrl, entryUrl }
  }])
  assert(legacyReads.length > 0)
  assert(resourceReads.length > 0)
  for (const [url, purpose] of [...legacyReads, ...resourceReads]) {
    assert.equal(purpose, url.endsWith('/package.json') ? 'packageMetadata' : 'module')
  }
  await manager.close()
})

test('optional resource graph leaves a self-contained ESM plugin on V1', async () => {
  const simpleRoot = 'holo-plugins:///simple/'
  const simpleEntry = `${simpleRoot}index.mjs`
  const source = 'export default function simple() {}'
  const bytes = Buffer.from(source)
  let resourceReads = 0
  const native = {
    pluginSource(url) {
      return url === simpleEntry
        ? JSON.stringify({ bytes: [...bytes], sha256: createHash('sha256').update(bytes).digest('hex') })
        : null
    },
    pluginSourceResource() {
      resourceReads += 1
      throw new Error('V1 must not read the project resource graph')
    },
    pluginPlan(_encoded, digest) {
      return `${simpleEntry}?holo-bundle=${digest}`
    },
    pluginGraphRelease() {}
  }
  const manager = createNativePluginHost(native, {}, {})
  await manager.prepareHostPlugins([{
    config: {},
    configSchema: null,
    entryUrl: simpleEntry,
    exportName: 'default',
    instanceId: 'simple',
    integrity: null,
    rootUrl: simpleRoot,
    resourceGraph: { schemaVersion: 2, rootUrl: simpleRoot, entryUrl: simpleEntry }
  }])
  assert.equal(resourceReads, 0)
  await manager.close()
})

test('native URL shim validates encoded source names the same as Node URL', () => {
  const originalUrl = globalThis.URL
  try {
    globalThis.URL = RuntimeURL
    for (const name of ['name%20space.mjs', 'caf%C3%A9.mjs']) {
      const encodedRoot = 'holo-plugins:///encoded/'
      const encodedEntry = `${encodedRoot}${name}`
      const bytes = Buffer.from('export default 1')
      const raw = {
        config: {},
        entryUrl: encodedEntry,
        exportName: 'default',
        instanceId: 'encoded',
        rootUrl: encodedRoot,
        schemaVersion: 2,
        sourceClosure: {
          kind: 'source-closure',
          entryUrl: encodedEntry,
          rootUrl: encodedRoot,
          reads: [{
            url: encodedEntry,
            byteLength: bytes.length,
            bytesBase64: bytes.toString('base64'),
            sha256: createHash('sha256').update(bytes).digest('hex')
          }],
          aliases: [],
          externalReferences: []
        }
      }
      const [accepted] = normalizeRuntimePluginBundlesV2([{
        ...raw,
        bundleSha256: runtimePluginBundleDigestV2(raw)
      }])
      assert.equal(accepted.entryUrl, encodedEntry)
    }
  } finally {
    globalThis.URL = originalUrl
  }
})
