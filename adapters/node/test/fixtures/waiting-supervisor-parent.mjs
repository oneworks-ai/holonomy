import process from 'node:process'

import { NodeRuntimeSupervisor } from '../../src/supervisor.mjs'

const entryUrl = 'app://inspector/orphan-check.mjs'
const main = async () => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5_000 })
  const status = await supervisor.start({
    entryUrl,
    inspector: { enabled: true, waitForDebugger: true },
    runtimeModules: [],
    syntheticModules: {},
    userModules: [{ source: `console.log('ORPHANED_ENTRY')`, url: entryUrl }]
  })
  process.stdout.write(`${JSON.stringify({ childPid: status.pid })}\n`)
  setInterval(() => undefined, 60_000)
}

void main().catch(() => process.exit(1))
