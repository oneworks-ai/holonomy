import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { capabilityRuntimeSession } from './capability-runtime-fixture.mjs'

const entryUrl = 'app+local://workspace/main.mjs'
const moduleRootUrl = 'app+local://workspace/'
const processProfile = () => ({
  backend: {
    backendId: 'native.darwin-seatbelt-v1',
    configuration: {
      runtimeReadPaths: ['/opt/homebrew'],
      sandboxExecutablePath: '/usr/bin/sandbox-exec'
    }
  },
  environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
  executables: [{
    executableId: 'node-helper',
    executablePath: process.execPath,
    fixedArgs: [],
    shell: false
  }],
  profile: 'process-profile-v1'
})

const admissionFixture = async (t, name, source) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `holonomy-capability-process-${name}-`))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  return {
    logs,
    session: capabilityRuntimeSession({
      entryUrl,
      hostPath: root,
      moduleRootUrl,
      processProfile: processProfile(),
      source
    }),
    supervisor
  }
}

test('rejects a Process Policy and Host profile mismatch before Guest entry', {
  skip: process.platform !== 'darwin'
}, async t => {
  const fixture = await admissionFixture(t, 'intersection', 'console.log("PROCESS_INTERSECTION_SIDE_EFFECT")')
  fixture.session.capabilityRuntime.runtimeCreation.configuration.sandboxPolicy.process.executables = [{
    argumentBytes: 64 * 1024,
    executableId: 'different-helper'
  }]

  await assert.rejects(fixture.supervisor.start(fixture.session), TypeError)
  assert.equal(fixture.supervisor.generation, 0)
  assert.equal(fixture.logs.some(value => value.includes('PROCESS_INTERSECTION_SIDE_EFFECT')), false)
})

test('rejects Inspector with a Host-only Process profile before Guest entry', {
  skip: process.platform !== 'darwin'
}, async t => {
  const fixture = await admissionFixture(t, 'inspector', 'console.log("PROCESS_INSPECTOR_SIDE_EFFECT")')
  fixture.session.inspector = { enabled: true, waitForDebugger: false }
  fixture.session.capabilityRuntime.runtimeCreation.configuration.inspector.enabled = true

  await assert.rejects(fixture.supervisor.start(fixture.session), TypeError)
  assert.equal(fixture.supervisor.generation, 0)
  assert.equal(fixture.logs.some(value => value.includes('PROCESS_INSPECTOR_SIDE_EFFECT')), false)
})
