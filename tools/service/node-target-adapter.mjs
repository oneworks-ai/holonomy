import { NodeRuntimeSupervisor } from '../../adapters/node/src/index.mjs'

import { CdpWebSocketTransport } from './cdp-websocket-transport.mjs'
import { serviceError } from './errors.mjs'
import { createNodeLocalAdapter } from './target-adapters.mjs'

const EXIT_LOG = /^Runtime terminated: process\.exit\((\d{1,3})\)$/u

const requireRecord = (records, processId) => {
  const record = records.get(processId)
  if (record == null) throw serviceError('service.not_found', 'Node runtime process was not found')
  return record
}

const publishTerminal = (record, terminal) => {
  if (record.terminal != null || record.stopping) return
  record.terminal = Object.freeze(terminal)
  for (const listener of [...record.terminalListeners]) {
    try {
      listener(record.terminal)
    } catch {
      record.terminalListeners.delete(listener)
    }
  }
}

const createRecord = (supervisor, process) => {
  const diagnosticListeners = new Set()
  const record = {
    diagnostics: Object.freeze({
      subscribe(listener) {
        diagnosticListeners.add(listener)
        return () => diagnosticListeners.delete(listener)
      }
    }),
    inspectorUrl: undefined,
    logs: [],
    nextSequence: 1,
    processGeneration: process.generation,
    stopping: false,
    supervisor,
    terminal: undefined,
    terminalListeners: new Set(),
    transports: new Map()
  }
  supervisor.on('log', event => {
    record.logs.push({ chunk: event.text, sequence: record.nextSequence++, stream: event.level })
    if (record.logs.length > 4_096) record.logs.shift()
    const match = EXIT_LOG.exec(event.text)
    if (match == null) return
    const code = Number(match[1])
    publishTerminal(record, {
      exit: { code, reason: code === 0 ? 'completed' : 'failed' },
      generation: record.processGeneration,
      state: code === 0 ? 'exited' : 'failed'
    })
    void supervisor.stop().catch(() => undefined)
  })
  supervisor.on('network', event => {
    for (const listener of [...diagnosticListeners]) {
      try {
        listener(event.diagnostic)
      } catch {
        diagnosticListeners.delete(listener)
      }
    }
  })
  supervisor.on('inspector', event => {
    record.inspectorUrl = event.url
  })
  supervisor.on('state', event => {
    if (event.state === 'failed') {
      publishTerminal(record, {
        exit: { code: 1, reason: 'failed' },
        generation: record.processGeneration,
        state: 'failed'
      })
    }
  })
  return record
}

const closeRecord = async record => {
  record.stopping = true
  for (const cdpTransport of record.transports.values()) cdpTransport.close()
  record.transports.clear()
  await record.supervisor.stop()
  record.terminalListeners.clear()
}

const toNodeSession = (process, initialNetworkRuleSet, sandboxPlan) => ({
  argv: process.launch.argv ?? [],
  entryUrl: process.entryUrl,
  env: process.launch.env ?? {},
  inspector: {
    enabled: process.inspectorMode !== 'off',
    waitForDebugger: process.inspectorMode === 'break'
  },
  ...(process.launch.moduleRootUrl == null ? {} : { moduleRootUrl: process.launch.moduleRootUrl }),
  ...(initialNetworkRuleSet == null ? {} : { networkRules: initialNetworkRuleSet }),
  runtimeModules: [],
  sandboxPlan,
  sandboxPolicy: process.sandboxPolicy,
  syntheticModules: {},
  userEntryUrl: process.launch.userEntryUrl ?? process.entryUrl,
  userModules: process.launch.modules ?? []
})

export const createNodeRuntimeAdapter = (options = {}) => {
  const records = new Map()
  const createSupervisor = options.createSupervisor ?? (() => new NodeRuntimeSupervisor())
  const transport = options.createTransport ?? (url => new CdpWebSocketTransport(url))
  return createNodeLocalAdapter({
    applyNetworkRules: async ({ networkRules, process }) => {
      const record = requireRecord(records, process.id)
      await record.supervisor.setRules(
        { mode: networkRules.mode, rules: networkRules.rules },
        Number(networkRules.ruleRevision)
      )
    },
    close: async () => {
      await Promise.allSettled([...records.values()].map(closeRecord))
      records.clear()
    },
    closeInspector: async ({ inspector }) => {
      records.get(inspector.processId)?.transports.get(inspector.id)?.close()
      records.get(inspector.processId)?.transports.delete(inspector.id)
    },
    openInspector: async ({ inspector, process }) => {
      const record = requireRecord(records, process.id)
      if (record.inspectorUrl == null) throw serviceError('service.precondition_failed', 'Inspector is unavailable')
      const cdpTransport = transport(record.inspectorUrl)
      record.transports.set(inspector.id, cdpTransport)
      return { targetSession: process.generation, transport: cdpTransport }
    },
    readLogs: async ({ after, limit, process }) => {
      const record = requireRecord(records, process.id)
      const events = record.logs.filter(event => event.sequence > after).slice(0, limit)
      return { cursor: events.at(-1)?.sequence ?? after, events }
    },
    reconcileProcess: async () => ({ cleaned: true }),
    removeNetworkRules: async ({ networkRules, process }) => {
      const record = requireRecord(records, process.id)
      await record.supervisor.setRules(
        { mode: networkRules.mode, rules: [] },
        Number(networkRules.ruleRevision)
      )
    },
    removeProcess: async ({ process }) => {
      const record = records.get(process.id)
      if (record == null) return
      await closeRecord(record)
      records.delete(process.id)
    },
    resumeProcess: async ({ process }) => {
      const record = requireRecord(records, process.id)
      if (record.inspectorUrl == null) throw serviceError('service.precondition_failed', 'Inspector is unavailable')
      const cdpTransport = transport(record.inspectorUrl)
      try {
        const response = await cdpTransport.send({ id: 1, method: 'Runtime.runIfWaitingForDebugger' })
        if (response.error != null) throw serviceError('service.unavailable', 'Runtime resume failed')
        await record.supervisor.resume()
      } finally {
        cdpTransport.close()
      }
    },
    startProcess: async ({ initialNetworkRuleSet, process, sandboxPlan }) => {
      const previous = records.get(process.id)
      if (previous != null) await closeRecord(previous)
      const supervisor = createSupervisor()
      const record = createRecord(supervisor, process)
      records.set(process.id, record)
      const result = await supervisor.start(toNodeSession(process, initialNetworkRuleSet, sandboxPlan))
      record.inspectorUrl = result.inspectorUrl
      return {
        diagnostics: record.diagnostics,
        waitingForDebugger: process.inspectorMode === 'break'
      }
    },
    stopProcess: async ({ process }) => {
      const record = records.get(process.id)
      if (record != null) await closeRecord(record)
    },
    subscribeProcess: ({ onTerminal, process }) => {
      const record = requireRecord(records, process.id)
      if (record.processGeneration !== process.generation) {
        throw serviceError('service.precondition_failed', 'Node Runtime generation is stale')
      }
      record.terminalListeners.add(onTerminal)
      if (record.terminal != null) queueMicrotask(() => onTerminal(record.terminal))
      return () => record.terminalListeners.delete(onTerminal)
    }
  })
}
