import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { capabilityRuntimeSession } from './capability-runtime-fixture.mjs'

test('rejects stdio that exceeds the Host open-pipe limit before spawn', {
  skip: process.platform !== 'darwin'
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-process-pipes-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  await supervisor.start(capabilityRuntimeSession({
    entryUrl: 'app+local://workspace/main.mjs',
    hostPath: root,
    moduleRootUrl: 'app+local://workspace/',
    processLimits: { maxOpenPipes: 2 },
    processProfile: {
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
    },
    source: `
      import { spawn } from 'node:child_process'
      let code
      try { spawn('node-helper', ['-e', '0']) }
      catch (error) { code = error.code }
      console.log('CAPABILITY_PROCESS_PIPE_LIMIT:' + JSON.stringify({ code }))
    `
  }))
  const line = logs.find(value => value.startsWith('CAPABILITY_PROCESS_PIPE_LIMIT:'))
  const result = JSON.parse(line.slice(30))
  assert.equal(result.code, 'EMFILE')
})
