import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { assetRoot, entryUrl, moduleRootUrl, processProfileV1 } from './capability-process-v86-runtime-support.mjs'
import { capabilityRuntimeSession } from './capability-runtime-fixture.mjs'

test('ignores a Host exec decision that arrives after the in-Guest gate deadline', {
  skip: assetRoot == null,
  timeout: 90_000
}, async t => {
  const processProfile = await processProfileV1(assetRoot)
  processProfile.backend.configuration.supervisor.execGateTimeoutMs = 1
  processProfile.environment.allowedScopes = ['runtime']
  processProfile.environment.defaultScope = 'runtime'
  const filesystemRoot = await mkdtemp(path.join(os.tmpdir(), 'holonomy-v86-exec-timeout-'))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 75_000 })
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  t.after(async () => {
    await supervisor.stop()
    await rm(filesystemRoot, { force: true, recursive: true })
  })
  const session = capabilityRuntimeSession({
    behavior: 'timeout',
    entryUrl,
    hostPath: filesystemRoot,
    middlewareMatcher: { member: 'authorizeDescendantProcess' },
    moduleRootUrl,
    processBackendInstallation: {
      artifactRoot: assetRoot,
      backendId: 'experimental.v86-v1',
      implementation: 'builtin.v86-v1'
    },
    processLimits: { maxExecutionTimeMs: 60_000 },
    processProfile,
    source: `
      import { spawn } from 'node:child_process'
      const first = await new Promise((resolve, reject) => {
        const child = spawn('shell', [
          '-c',
          'if /bin/cat /dev/null; then exit 91; else printf "EXEC_GATE_TIMED_OUT\\n"; fi; while :; do :; done',
        ])
        let output = ''
        child.stdout.on('data', chunk => {
          output += new TextDecoder().decode(chunk)
          if (output.includes('EXEC_GATE_TIMED_OUT')) child.kill('SIGKILL')
        })
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ code, output, signal }))
      })
      const second = await new Promise((resolve, reject) => {
        const child = spawn('shell', ['-c', 'printf "ENVIRONMENT_STILL_ALIVE\\n"'])
        let output = ''
        child.stdout.on('data', chunk => { output += new TextDecoder().decode(chunk) })
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ code, output, signal }))
      })
      console.log('V86_EXEC_TIMEOUT:' + JSON.stringify({ first, second }))
    `
  })
  try {
    await supervisor.start(session)
  } catch (error) {
    throw new Error(`v86 late exec response failed\n${logs.join('\n')}`, { cause: error })
  }
  const line = logs.find(value => value.startsWith('V86_EXEC_TIMEOUT:'))
  assert.ok(line)
  const result = JSON.parse(line.slice(17))
  assert.equal(result.first.output, 'EXEC_GATE_TIMED_OUT\n')
  assert.equal(result.first.signal, 'SIGKILL')
  assert.deepEqual(result.second, { code: 0, output: 'ENVIRONMENT_STILL_ALIVE\n', signal: null })
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
