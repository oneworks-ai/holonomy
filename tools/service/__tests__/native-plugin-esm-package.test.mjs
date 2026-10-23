import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it } from 'vitest'

import { runtimePluginBundleDigestV1 } from '../../../packages/runtime/src/app/plugin-bundle.ts'
import { materializeNativePluginGraph } from '../native-plugin-materialization.mjs'

describe('native self-contained ESM plugin staging', () => {
  it('declares generated packages as ESM without changing bundle files or digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-plugin-esm-manifest-'))
    const source = 'export default()=>{}'
    const raw = {
      config: {},
      entryUrl: 'holo-plugins:///esm/index.js',
      exportName: 'default',
      files: [{
        sha256: createHash('sha256').update(source).digest('hex'),
        source,
        url: 'holo-plugins:///esm/index.js'
      }],
      instanceId: 'esm',
      rootUrl: 'holo-plugins:///esm/',
      schemaVersion: 1
    }
    const digest = runtimePluginBundleDigestV1(raw)
    try {
      const prepared = await materializeNativePluginGraph(root, 1, [{ ...raw, bundleSha256: digest }])
      const packageRoot = join(prepared.directory, 'esm')
      const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
      assert.equal(manifest.type, 'module')
      assert.equal(manifest.holo.entry, 'index.js')
      assert.equal(await readFile(join(packageRoot, 'index.js'), 'utf8'), source)
      assert.equal(prepared.plugins[0].integrity, digest)
      assert.equal(runtimePluginBundleDigestV1(raw), digest)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
