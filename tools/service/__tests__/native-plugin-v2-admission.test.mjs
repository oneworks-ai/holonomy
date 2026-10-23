import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, it } from 'vitest'

import { runtimePluginBundleDigestV2 } from '../../../src/runtime/plugin-bundle.ts'
import { admitRuntimePluginUpdate } from '../capability-runtime-plugin-registry.mjs'
import { createInitialServiceState } from '../constants.mjs'
import { admitProcessStart } from '../process-registry.mjs'
import { validateServiceRequest } from '../request-schemas.mjs'

const bundle = () => {
  const rootUrl = 'holo-plugins:///package-graph/'
  const entryUrl = `${rootUrl}entry.mjs`
  const bytes = Buffer.from('export default () => {}')
  const raw = {
    schemaVersion: 2,
    instanceId: 'package-graph',
    entryUrl,
    rootUrl,
    exportName: 'default',
    config: {},
    sourceClosure: {
      kind: 'source-closure',
      entryUrl,
      rootUrl,
      reads: [{
        url: entryUrl,
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytesBase64: bytes.toString('base64')
      }],
      aliases: [],
      externalReferences: []
    }
  }
  return { ...raw, bundleSha256: runtimePluginBundleDigestV2(raw) }
}

// These are admission-owner unit tests, not Native execution evidence. Only a
// successful pure state mutation is committed; no Adapter or Provider runs.
const context = target => {
  let state = createInitialServiceState()
  const id = `${target}:local`
  state.resources.devices[id] = { id, platform: target, state: 'online' }
  const owner = {
    now: () => 1000,
    retentionMs: 60_000,
    get state() {
      return state
    },
    store: {
      async transact(_event, mutate) {
        const next = structuredClone(state)
        const result = mutate(next)
        state = next
        return result
      }
    }
  }
  return owner
}

const request = target => ({
  deviceId: `${target}:local`,
  entryUrl: 'app://workspace/index.mjs',
  inspectorMode: 'off',
  isolation: 'runtime',
  target,
  launch: {
    argv: ['app://workspace/index.mjs'],
    command: 'run',
    entryUrl: 'app://workspace/index.mjs',
    moduleRootUrl: 'app://workspace/',
    modules: [{ url: 'app://workspace/index.mjs', source: 'console.log(42)' }],
    schemaVersion: 2,
    target
  },
  runtimePlugins: [bundle()]
})

describe('native-only plugin source graph admission', () => {
  it('publishes the same strict V2 shape through OpenAPI and Native start admission', async () => {
    const input = request('native')
    assert.equal(validateServiceRequest('ProcessStartRequest', input).runtimePlugins[0].schemaVersion, 2)
    const owner = context('native')
    const admitted = await admitProcessStart(owner, input, 'v2-start')
    assert.equal(admitted.value.process.runtimePlugins[0].schemaVersion, 2)
    assert.deepEqual(
      JSON.parse(JSON.stringify(owner.state.resources.processes[admitted.value.process.id].runtimePlugins)),
      input.runtimePlugins
    )
    const malformed = structuredClone(input)
    malformed.runtimePlugins[0].sourceClosure.path = '/private/override'
    assert.throws(() => validateServiceRequest('ProcessStartRequest', malformed), {
      code: 'service.invalid_request'
    })
  })

  it('rejects V2 at Node and Android start before any state admission', async () => {
    for (const target of ['node', 'android']) {
      const owner = context(target)
      await assert.rejects(admitProcessStart(owner, request(target), `v2-${target}`), {
        code: 'sandbox.capability_unsupported'
      })
      assert.deepEqual(owner.state.resources.processes, {})
      assert.deepEqual(owner.state.resources.operations, {})
    }
  })

  it('allows Native watch snapshots and rejects V2 on other target resources atomically', async () => {
    for (const target of ['native', 'node', 'android']) {
      const owner = context(target)
      owner.state.resources.processes.process_graph = {
        id: 'process_graph',
        generation: 1,
        pluginGraphRevision: 1,
        revision: 1,
        state: 'running',
        target
      }
      const input = validateServiceRequest('RuntimePluginsReplaceRequest', {
        expectedGeneration: 1,
        runtimePlugins: [bundle()]
      })
      const pending = admitRuntimePluginUpdate(
        owner,
        'process_graph',
        1,
        input.runtimePlugins,
        1,
        `v2-watch-${target}`
      )
      if (target === 'native') {
        const admitted = await pending
        assert.equal(admitted.value.process.pendingPluginUpdate.runtimePlugins[0].schemaVersion, 2)
      } else {
        await assert.rejects(pending, { code: 'sandbox.capability_unsupported' })
        assert.equal(owner.state.resources.processes.process_graph.pendingPluginUpdate, undefined)
        assert.deepEqual(owner.state.resources.operations, {})
      }
    }
  })
})
