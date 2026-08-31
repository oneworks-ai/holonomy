/* eslint-disable max-lines -- child IPC lifecycle and generation fencing share one state machine. */

import inspector from 'node:inspector'
import process from 'node:process'

import { applyNodeRuntimePluginUpdateV1 } from './child-plugin-update.mjs'
import { SessionModuleGraph } from './module-graph.mjs'
import { NODE_ADAPTER_PROTOCOL_VERSION, childEvent } from './protocol.mjs'
import { createRuntimeContext, drainRuntimeLogs } from './runtime-context.mjs'
import { NodeRuntimeHostController } from './runtime-host-controller.mjs'
import { normalizeNetworkRules, normalizeNodeRuntimeSession } from './session-validation.mjs'

let generation = 0
let graph
let hostController
let networkRules = Object.freeze({ mode: 'passthrough', rules: Object.freeze([]) })
let pluginGraphRevision = 0
let rulesRevision = 0
let runtimeContext
let state = 'idle'

const send = message =>
  new Promise((resolve, reject) => {
    if (process.send == null) return reject(new Error('Node adapter IPC is unavailable'))
    process.send(message, error => error == null ? resolve() : reject(error))
  })

const emit = async (type, fields = {}) => send(childEvent(type, generation, fields))

const transition = async nextState => {
  state = nextState
  await emit('state', { state })
}

const flushLogs = async () => {
  if (runtimeContext == null) return
  for (const record of drainRuntimeLogs(runtimeContext)) await emit('log', record)
}

const acknowledge = async (requestId, value = undefined) => {
  await emit('ack', { ok: true, requestId, ...(value === undefined ? {} : { value }) })
}

const reject = async (requestId, code) => emit('ack', { error: { code }, ok: false, requestId })

const status = () => ({
  generation,
  inspectorUrl: inspector.url() ?? null,
  pid: process.pid,
  pluginGraphRevision,
  rulesRevision,
  state
})

const runEntry = async (requestId, acknowledged) => {
  let stage = 'entry_evaluation'
  try {
    await graph.evaluateEntry()
    stage = 'log_flush'
    await flushLogs()
    if (state !== 'running') await transition('running')
    if (!acknowledged) await acknowledge(requestId, status())
  } catch {
    await emit('log', { level: 'error', text: `Node Runtime start failed: ${stage}` }).catch(() => undefined)
    await flushLogs()
    await hostController?.dispose().catch(() => undefined)
    await transition('failed')
    if (!acknowledged) await reject(requestId, `start_failed.${stage}`)
  }
}

const start = async command => {
  if (state !== 'idle') return reject(command.requestId, 'invalid_state')
  generation = command.generation
  await transition('starting')
  let acknowledged = false
  let stage = 'session_validation'
  try {
    const session = normalizeNodeRuntimeSession(command.value)
    networkRules = session.networkRules
    pluginGraphRevision = session.pluginGraphRevision
    stage = 'runtime_context'
    runtimeContext = createRuntimeContext(`holonomy-runtime-${generation}`)
    stage = 'module_graph'
    graph = new SessionModuleGraph(runtimeContext, session)
    stage = 'host_bridge'
    hostController = new NodeRuntimeHostController({
      emitLog: record => {
        void emit('log', record).catch(() => undefined)
      },
      emitNetwork: diagnostic => {
        void emit('network', { diagnostic }).catch(() => undefined)
      },
      generation,
      graph,
      runtimeContext,
      session
    })
    stage = 'runtime_plugins'
    await hostController.startPlugins()
    stage = 'inspector'
    const inspectorUrl = inspector.url()
    if (session.inspector.enabled && inspectorUrl != null) {
      await transition(session.inspector.waitForDebugger ? 'waiting_for_debugger' : 'running')
      await emit('inspector', { url: inspectorUrl, waitForDebugger: session.inspector.waitForDebugger })
      await acknowledge(command.requestId, status())
      acknowledged = true
      if (session.inspector.waitForDebugger) return
    }
    await runEntry(command.requestId, acknowledged)
  } catch {
    await emit('log', { level: 'error', text: `Node Runtime start failed: ${stage}` }).catch(() => undefined)
    await flushLogs()
    await hostController?.dispose().catch(() => undefined)
    await transition('failed')
    if (!acknowledged) await reject(command.requestId, `start_failed.${stage}`)
  }
}

const resume = async command => {
  if (state !== 'waiting_for_debugger') return reject(command.requestId, 'invalid_state')
  await transition('running')
  await acknowledge(command.requestId, status())
  await runEntry(command.requestId, true)
}

const updateRules = async command => {
  if (state !== 'running') return reject(command.requestId, 'invalid_state')
  const revision = command.value?.revision
  if (!Number.isSafeInteger(revision) || revision <= rulesRevision) {
    return reject(command.requestId, 'invalid_rules_revision')
  }
  let nextRules
  try {
    nextRules = normalizeNetworkRules(command.value.rules)
  } catch {
    return reject(command.requestId, 'invalid_rules')
  }
  try {
    await hostController?.updateRules(nextRules)
  } catch {
    return reject(command.requestId, 'invalid_rules')
  }
  networkRules = nextRules
  rulesRevision = revision
  await emit('network', { diagnostic: { kind: 'rules.updated', revision, ruleCount: networkRules.rules.length } })
  await acknowledge(command.requestId, { revision })
}

const updatePlugins = async command => {
  if (state !== 'running') return reject(command.requestId, 'invalid_state')
  const result = await applyNodeRuntimePluginUpdateV1(command, pluginGraphRevision, hostController)
  if (result.error != null) return reject(command.requestId, result.error)
  pluginGraphRevision = result.revision
  await acknowledge(command.requestId, { pluginGraphRevision })
}

const stop = async command => {
  if (state !== 'stopped') await transition('stopping')
  await hostController?.dispose().catch(() => undefined)
  graph = undefined
  hostController = undefined
  runtimeContext = undefined
  networkRules = Object.freeze({ mode: 'passthrough', rules: Object.freeze([]) })
  await transition('stopped')
  await acknowledge(command.requestId)
  process.disconnect()
}

const validCommand = command =>
  command != null && typeof command === 'object' && !Array.isArray(command) &&
  command.protocolVersion === NODE_ADAPTER_PROTOCOL_VERSION && Number.isSafeInteger(command.requestId) &&
  Number.isSafeInteger(command.generation) &&
  ['plugins', 'resume', 'rules', 'start', 'status', 'stop'].includes(command.type)

process.on('message', command => {
  void (async () => {
    if (!validCommand(command)) return
    if (command.type !== 'start' && command.generation !== generation) return
    if (command.type === 'start') return start(command)
    if (command.type === 'resume') return resume(command)
    if (command.type === 'plugins') return updatePlugins(command)
    if (command.type === 'rules') return updateRules(command)
    if (command.type === 'status') return acknowledge(command.requestId, status())
    await stop(command)
  })().catch(async () => {
    try {
      await emit('fatal', { code: 'child_failure' })
    } finally {
      process.exitCode = 1
      process.disconnect()
    }
  })
})

process.once('disconnect', () => {
  if (state === 'stopped' || state === 'stopping') return
  void (async () => {
    state = 'stopping'
    await hostController?.dispose().catch(() => undefined)
    graph = undefined
    hostController = undefined
    runtimeContext = undefined
    process.exit(1)
  })()
})

process.on('uncaughtException', () => {
  void emit('fatal', { code: 'uncaught_exception' }).finally(() => process.exit(1))
})

process.on('unhandledRejection', () => {
  void emit('fatal', { code: 'unhandled_rejection' }).finally(() => process.exit(1))
})
