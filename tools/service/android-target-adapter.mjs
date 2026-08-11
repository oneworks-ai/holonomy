import { readTarget } from '../android-devtools-cdp.mjs'
import { createAdbPort } from './adb-port.mjs'
import { AndroidAdbLeaseStore } from './android-adb-lease-store.mjs'
import { createAndroidSessionCommandPort } from './android-command-port.mjs'
import { createAndroidEmulatorManager } from './android-emulator-manager.mjs'
import { observeAndroidReply, stopAndroidProcessMonitor, subscribeAndroidProcess } from './android-process-monitor.mjs'
import { reconcileAndroidRuntime } from './android-runtime-reconcile.mjs'
import { createAndroidRuntimeSpec } from './android-runtime-spec.mjs'
import {
  androidInspectorSocket,
  androidSerialOf,
  applyAndroidControl,
  closeAndroidRecord,
  requireAndroidRuntime
} from './android-target-support.mjs'
import { CdpWebSocketTransport } from './cdp-websocket-transport.mjs'
import { serviceError } from './errors.mjs'

export const createAndroidRuntimeAdapter = (options = {}) => {
  const leaseStore = options.leaseStore ?? new AndroidAdbLeaseStore({ file: options.leaseStateFile })
  const commandPort = options.commandPort ?? createAndroidSessionCommandPort({ ...options, leaseStore })
  const emulatorManager = options.emulatorManager ?? createAndroidEmulatorManager({
    ...options,
    stateFile: options.emulatorStateFile
  })
  const records = new Map()
  const reverses = new Map()
  const createTransport = options.createTransport ?? (url => new CdpWebSocketTransport(url))
  return createAdbPort({
    applyNetworkRules: async ({ networkRules, process, signal }) => {
      await applyAndroidControl(commandPort, process, {
        expectedRevision: String(Math.max(0, Number(networkRules.ruleRevision) - 1)),
        rules: { mode: networkRules.mode, rules: networkRules.rules }
      }, signal)
    },
    close: async () => {
      await emulatorManager.close()
      await Promise.allSettled([...records.entries()].map(async ([processId, record]) => {
        const reverseEntries = [...reverses.entries()].filter(([key]) => key.startsWith(`${processId}:`))
        await closeAndroidRecord(record, commandPort, reverseEntries[0]?.[1])
      }))
      records.clear()
      reverses.clear()
      await commandPort.close?.()
    },
    closeInspector: async ({ inspector }) => {
      const record = records.get(inspector.processId)
      record?.transports.get(inspector.id)?.close()
      record?.transports.delete(inspector.id)
    },
    exposeFixture: async ({ baseUrl, process }) => {
      const port = Number(new URL(baseUrl).port)
      const serial = androidSerialOf(process)
      await commandPort.reverse(serial, port, { generation: process.generation, processId: process.id })
      reverses.set(`${process.id}:${process.generation}`, { port, serial })
      return `http://127.0.0.1:${port}`
    },
    listDevices: async () => await commandPort.listDevices(),
    listEmulators: async () => await emulatorManager.listEmulators(),
    openInspector: async ({ inspector, process }) => {
      const record = requireAndroidRuntime(records, process.id)
      if (record.target == null) throw serviceError('service.precondition_failed', 'Inspector is unavailable')
      const transport = createTransport(record.target.webSocketDebuggerUrl)
      record.transports.set(inspector.id, transport)
      return {
        discoveryUrl: `http://127.0.0.1:${record.localPort}/json/list`,
        localPort: record.localPort,
        targetSession: process.generation,
        transport
      }
    },
    readLogs: async ({ after, limit, process }) => {
      const record = requireAndroidRuntime(records, process.id)
      const reply = await commandPort.command(record.serial, {
        afterOutputSequence: after,
        command: 'status',
        expectedGeneration: record.generation,
        runtimeId: process.id
      })
      observeAndroidReply(record, reply)
      const events = (reply.output?.events ?? []).slice(0, limit).map(event => ({
        chunk: event.chunk,
        generation: event.generation,
        sequence: event.sequence,
        stream: event.stream
      }))
      return { cursor: events.at(-1)?.sequence ?? after, events }
    },
    reconcileProcess: async ({ process, signal }) => await reconcileAndroidRuntime(commandPort, process, signal),
    removeNetworkRules: async ({ networkRules, process, signal }) => {
      await applyAndroidControl(commandPort, process, {
        expectedRevision: String(Math.max(0, Number(networkRules.ruleRevision) - 1)),
        rules: { mode: networkRules.mode, rules: [] }
      }, signal)
    },
    removeProcess: async ({ process }) => {
      const record = records.get(process.id)
      if (record == null) return
      const reverseKey = `${process.id}:${process.generation}`
      await closeAndroidRecord(record, commandPort, reverses.get(reverseKey))
      await commandPort.command(record.serial, {
        command: 'dispose',
        expectedGeneration: record.generation,
        runtimeId: process.id
      })
      records.delete(process.id)
      reverses.delete(reverseKey)
    },
    restartEmulator: async input => await emulatorManager.restartEmulator(input),
    resumeProcess: async ({ process }) => {
      const record = requireAndroidRuntime(records, process.id)
      if (record.target == null) throw serviceError('service.precondition_failed', 'Inspector is unavailable')
      const transport = createTransport(record.target.webSocketDebuggerUrl)
      try {
        const response = await transport.send({ id: 1, method: 'Runtime.runIfWaitingForDebugger' })
        if (response.error != null) throw serviceError('service.unavailable', 'Runtime resume failed')
      } finally {
        transport.close()
      }
    },
    startProcess: async ({ initialNetworkRuleSet, process, signal }) => {
      const serial = androidSerialOf(process)
      let record = records.get(process.id)
      if (record == null) {
        const socketName = process.inspectorMode === 'off' ? undefined : androidInspectorSocket(process.id)
        const created = await commandPort.command(serial, {
          command: 'create',
          runtimeId: process.id,
          spec: createAndroidRuntimeSpec(process, socketName, initialNetworkRuleSet)
        }, { signal })
        record = {
          generation: created.ack.generation,
          localPort: undefined,
          pollFailures: 0,
          pollTimer: undefined,
          processGeneration: process.generation,
          serial,
          socketName,
          stopping: false,
          target: undefined,
          terminal: undefined,
          terminalListeners: new Set(),
          transports: new Map()
        }
        records.set(process.id, record)
      } else {
        record.processGeneration = process.generation
        record.stopping = false
        record.terminal = undefined
      }
      const started = await commandPort.command(serial, {
        command: 'start',
        expectedGeneration: record.generation,
        runtimeId: process.id
      }, { signal })
      observeAndroidReply(record, started)
      if (record.socketName != null) {
        record.localPort ??= await commandPort.forwardInspector(serial, record.socketName, {
          generation: process.generation,
          processId: process.id
        })
        record.target = await readTarget(record.localPort)
      }
      return { waitingForDebugger: process.inspectorMode === 'break' }
    },
    startEmulator: async input => await emulatorManager.startEmulator(input),
    stopEmulator: async input => await emulatorManager.stopEmulator(input),
    stopProcess: async ({ process, signal }) => {
      const record = records.get(process.id)
      if (record == null) return
      stopAndroidProcessMonitor(record)
      const reply = await commandPort.command(record.serial, {
        command: 'stop',
        expectedGeneration: record.generation,
        reason: 'service_stop',
        runtimeId: process.id
      }, { signal })
      record.generation = reply.ack.generation
      const reverseKey = `${process.id}:${process.generation}`
      const reverse = reverses.get(reverseKey)
      await closeAndroidRecord(record, commandPort, reverse)
      reverses.delete(reverseKey)
    },
    subscribeProcess: ({ onTerminal, process }) => {
      const record = requireAndroidRuntime(records, process.id)
      if (record.processGeneration !== process.generation) {
        throw serviceError('service.precondition_failed', 'Android Runtime generation is stale')
      }
      return subscribeAndroidProcess(record, commandPort, process, onTerminal, options)
    }
  })
}
