import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { assetRoot, entryUrl, moduleRootUrl, processProfileV1 } from './capability-process-v86-runtime-support.mjs'
import { capabilityRuntimeSession } from './capability-runtime-fixture.mjs'

test('rejects a shared v86 runtime scope before Guest entry', {
  skip: assetRoot == null
}, async t => {
  const processProfile = await processProfileV1(assetRoot)
  processProfile.environment.allowedScopes = ['runtime']
  processProfile.environment.defaultScope = 'runtime'
  const filesystemRoot = await mkdtemp(path.join(os.tmpdir(), 'holonomy-v86-scope-denial-'))
  const supervisor = new NodeRuntimeSupervisor()
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  t.after(async () => {
    await supervisor.stop()
    await rm(filesystemRoot, { force: true, recursive: true })
  })
  const session = capabilityRuntimeSession({
    entryUrl,
    hostPath: filesystemRoot,
    moduleRootUrl,
    processBackendInstallation: {
      artifactRoot: assetRoot,
      backendId: 'experimental.v86-v1',
      implementation: 'builtin.v86-v1'
    },
    processProfile,
    source: `console.log('SHARED_V86_GUEST_ENTRY')`
  })
  await assert.rejects(supervisor.start(session))
  assert.equal(supervisor.generation, 0)
  assert.equal(logs.includes('SHARED_V86_GUEST_ENTRY'), false)
})

test('rejects a tampered installed v86 artifact before Guest entry', {
  skip: assetRoot == null
}, async () => {
  const processProfile = await processProfileV1(assetRoot)
  processProfile.backend.configuration.artifacts.kernel.sha256 = '0'.repeat(64)
  const supervisor = new NodeRuntimeSupervisor()
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  const session = capabilityRuntimeSession({
    entryUrl,
    hostPath: assetRoot,
    moduleRootUrl,
    processBackendInstallation: {
      artifactRoot: assetRoot,
      backendId: 'experimental.v86-v1',
      implementation: 'builtin.v86-v1'
    },
    processProfile,
    source: `console.log('TAMPERED_V86_GUEST_ENTRY')`
  })

  await assert.rejects(supervisor.start(session), TypeError)
  assert.equal(supervisor.generation, 0)
  assert.equal(logs.some(value => value.includes('TAMPERED_V86_GUEST_ENTRY')), false)
})
