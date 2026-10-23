/* eslint-disable test/no-import-node-test -- Adapter driver; public assertions run in Guest JS. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'

import {
  createProcessListenerPolicy,
  createProcessListenerProfile
} from '../../../tools/test-support/process-listener-profile.mjs'
import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { capabilityRuntimeSession } from './capability-runtime-fixture.mjs'

test('real Node Runtime runs the shared Process listener workload under an explicit profile', {
  skip: process.platform !== 'darwin'
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'holo-node-listeners-'))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 15_000 })
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  try {
    const helper = await readFile(
      new URL('../../../conformance/capabilities/process-listeners.test.mjs', import.meta.url),
      'utf8'
    )
    await supervisor.start(capabilityRuntimeSession({
      hostPath: root,
      entryUrl: 'app://listeners/index.mjs',
      moduleRootUrl: 'app://listeners/',
      processProfile: createProcessListenerProfile(),
      processLimits: createProcessListenerPolicy().limits,
      additionalUserModules: [{ url: 'app://listeners/listeners.mjs', source: helper }],
      source: [
        "import { registerNativeProcessListenerTests } from './listeners.mjs';",
        "import { run } from 'node:test';",
        "registerNativeProcessListenerTests({ executableId: 'echo', args: ['LISTENER_PAYLOAD'] });",
        "console.log('PROCESS_LISTENERS:' + JSON.stringify(await run()));"
      ].join('\n')
    }))
    let terminal
    for (let turn = 0; turn < 1000; turn++) {
      terminal = logs.find(line => line.startsWith('PROCESS_LISTENERS:'))
      if (terminal) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert(terminal, logs.join('\n'))
    const summary = JSON.parse(terminal.slice('PROCESS_LISTENERS:'.length))
    t.diagnostic(JSON.stringify(summary))
    assert.equal(summary.passed, 1, terminal)
    assert.equal(summary.failed, 0)
    assert.equal(summary.skipped, 0)
  } finally {
    await supervisor.stop()
    await rm(root, { recursive: true, force: true })
  }
})
