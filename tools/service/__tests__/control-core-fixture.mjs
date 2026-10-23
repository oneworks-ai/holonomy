import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdbPort } from '../adb-port.mjs'
import { HolonomyControlCore } from '../control-core.mjs'
import { serviceError } from '../errors.mjs'
import { ServiceLogStore } from '../service-log-store.mjs'
import { AtomicServiceStateStore } from '../state-store.mjs'

export const waitForOperation = async (core, id) => {
  for (let turn = 0; turn < 2_000; turn += 1) {
    const operation = core.get('operations', id, 'Operation')
    if (['cancelled', 'failed', 'succeeded'].includes(operation.state)) return operation
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  const operation = core.get('operations', id, 'Operation')
  throw new Error(`Operation did not settle: ${
    JSON.stringify({
      operation,
      process: core.get('processes', operation.target.id, 'Runtime process')
    })
  }`)
}

export const createHarness = async (options = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-core-'))
  const calls = []
  const startInputs = []
  const terminalListeners = new Map()
  const adbPort = createAdbPort({
    applyNetworkRules: async input => calls.push(`rules:${input.networkRules.ruleRevision}`),
    applyRuntimePlugins: async input => calls.push(`plugins:${input.revision}:${input.runtimePlugins.length}`),
    closeInspector: async input => calls.push(`close-inspector:${input.inspector.id}`),
    listDevices:
      async () => [{ id: 'android:emulator-5554', kind: 'emulator', serial: 'emulator-5554', state: 'online' }],
    openInspector: async input => ({
      discoveryUrl: `http://127.0.0.1:9229/${input.process.generation}`,
      localPort: 9_229,
      targetSession: input.process.generation
    }),
    readLogs: async input =>
      input.after >= 1
        ? { cursor: input.after, events: [] }
        : { cursor: 1, events: [{ chunk: 'ready', sequence: 1, stream: 'stdout' }] },
    removeNetworkRules: async input => calls.push(`remove-rules:${input.networkRules.ruleRevision}`),
    removeProcess: async input => calls.push(`remove:${input.process.generation}`),
    startProcess: async input => {
      calls.push(`start:${input.process.generation}`)
      startInputs.push(input)
      return { waitingForDebugger: input.process.inspectorMode === 'break' }
    },
    stopProcess: async input => {
      calls.push(`stop:${input.process.generation}`)
      if (options.failStop) throw serviceError('service.unavailable', 'stop failed')
    },
    subscribeProcess: ({ onTerminal, process }) => {
      const key = `${process.id}:${process.generation}`
      terminalListeners.set(key, onTerminal)
      return () => terminalListeners.delete(key)
    }
  })
  const core = new HolonomyControlCore({
    outputPump: options.outputPump,
    adbPort,
    logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
    store: new AtomicServiceStateStore({ directory })
  })
  await core.open()
  await core.refreshDevices()
  return {
    calls,
    close: async () => {
      await core.close()
      await rm(directory, { force: true, recursive: true })
    },
    core,
    startInputs,
    terminal(process, event) {
      terminalListeners.get(`${process.id}:${process.generation}`)?.({
        generation: process.generation,
        ...event
      })
    }
  }
}
