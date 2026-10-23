import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, vi } from 'vitest'
import { runtimePluginBundleDigestV2 } from '../../../packages/runtime/src/app/plugin-bundle-v2.ts'
import { materializeNativePluginGraph } from '../native-plugin-materialization.mjs'

vi.mock('../../../dist/runtime/index.js', async () => ({
  normalizeRuntimePluginBundles: (
    await import('../../../packages/runtime/src/app/plugin-bundle-v2.ts')
  ).normalizeRuntimePluginBundles
}))

const rootUrl = 'holo-plugins:///graph/'
const row = (url, source) => {
  const bytes = Buffer.from(source)
  return {
    url,
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytesBase64: bytes.toString('base64')
  }
}
const candidate = () => {
  const raw = {
    config: { label: 'test' },
    configSchema: { type: 'object', properties: { label: { type: 'string' } } },
    entryUrl: `${rootUrl}host/gate.mjs`,
    exportName: 'default',
    instanceId: 'graph',
    rootUrl,
    schemaVersion: 2,
    sourceClosure: {
      kind: 'source-closure',
      entryUrl: `${rootUrl}host/gate.mjs`,
      rootUrl,
      reads: [
        row(`${rootUrl}host/gate.mjs`, "import value from 'dep'; export default value"),
        row(`${rootUrl}node_modules/.pnpm/dep@1/node_modules/dep/index.mjs`, 'export default 1'),
        row(
          `${rootUrl}node_modules/.pnpm/dep@1/node_modules/dep/package.json`,
          '{"exports":"./index.mjs","type":"module"}'
        )
      ],
      aliases: [
        {
          url: `${rootUrl}node_modules/dep/index.mjs`,
          canonicalUrl: `${rootUrl}node_modules/.pnpm/dep@1/node_modules/dep/index.mjs`
        },
        {
          url: `${rootUrl}node_modules/dep/package.json`,
          canonicalUrl: `${rootUrl}node_modules/.pnpm/dep@1/node_modules/dep/package.json`
        }
      ],
      externalReferences: []
    }
  }
  return { ...raw, bundleSha256: runtimePluginBundleDigestV2(raw) }
}

describe('native Bundle V2 staging', () => {
  it('stages canonical bytes once and transmits only a private alias locator', async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), 'native-plugin-v2-stage-'))
    const bundle = candidate()
    try {
      const staged = await materializeNativePluginGraph(hostRoot, 3, [bundle])
      const sourceRoot = join(staged.directory, 'graph', 'sources')
      assert.equal(
        await readFile(join(sourceRoot, 'host', 'gate.mjs'), 'utf8'),
        "import value from 'dep'; export default value"
      )
      assert.equal(
        await readFile(join(sourceRoot, 'node_modules', '.pnpm', 'dep@1', 'node_modules', 'dep', 'index.mjs'), 'utf8'),
        'export default 1'
      )
      await assert.rejects(stat(join(sourceRoot, 'node_modules', 'dep', 'index.mjs')))
      const sidecar = JSON.parse(await readFile(join(staged.directory, 'graph', 'source-graph.json'), 'utf8'))
      assert.deepEqual(sidecar.aliases, bundle.sourceClosure.aliases)
      assert.deepEqual(sidecar.configSchema, bundle.configSchema)
      assert.equal(sidecar.bundleSha256, bundle.bundleSha256)
      assert.equal(staged.plugins[0].sourceGraph, './plugin-graphs/r3/graph/source-graph.json')
      assert.equal(staged.plugins[0].use, './plugin-graphs/r3/graph/sources/host/gate.mjs')
      assert.equal(staged.plugins[0].integrity, bundle.bundleSha256)
    } finally {
      await rm(hostRoot, { recursive: true, force: true })
    }
  })
})
