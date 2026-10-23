/* eslint-disable max-lines -- child IPC lifecycle and generation fencing share one state machine. */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import inspector from 'node:inspector'
import process from 'node:process'

import { applyNodeRuntimePluginUpdateV1 } from './child-plugin-update.mjs'
import { SessionModuleGraph } from './module-graph.mjs'
import { NODE_ADAPTER_PROTOCOL_VERSION, childEvent } from './protocol.mjs'
import { createRuntimeContext, drainRuntimeLogs } from './runtime-context.mjs'
import { NodeRuntimeHostController } from './runtime-host-controller.mjs'
import { normalizeNetworkRules, normalizeNodeRuntimeSession } from './session-validation.mjs'

let generation = 0
let dynamicImportOperations = 0
const engineGatePending = new Map()
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

const observe = (event, payload, correlationId = undefined) => {
  void emit('observer', {
    ...(correlationId == null ? {} : { correlationId }),
    event,
    payload
  }).catch(() => undefined)
}

const observeScriptCompiled = ({ source, url }) => {
  const sourceSha256 = createHash('sha256').update(source).digest('hex')
  observe('script.compiled', {
    origin: url,
    scriptId: `node-script-${sourceSha256.slice(0, 24)}`,
    sourceBytes: Buffer.byteLength(source),
    sourceSha256
  })
}

const gateDynamicImport = async (input, session) => {
  const policy = session.capabilityRuntime?.runtimeCreation.configuration.sandboxPolicy.codeGeneration.dynamicImport
  if (policy?.access !== 'controlled') throw new TypeError('Node Runtime dynamic import is denied')
  dynamicImportOperations += 1
  if (dynamicImportOperations > policy.maxOperations || typeof input.source !== 'string') {
    throw new TypeError('Node Runtime dynamic import limit exceeded')
  }
  const sourceBytes = Buffer.byteLength(input.source)
  if (sourceBytes > policy.maxSourceBytes) throw new TypeError('Node Runtime dynamic import source limit exceeded')
  const requestId = `module-${generation}-${dynamicImportOperations}`
  const decision = new Promise(resolve => engineGatePending.set(requestId, resolve))
  await emit('engineGate', {
    request: {
      codeKind: 'module',
      entryDetail: { kind: 'dynamicImport', source: 'loader' },
      metadataSupport: {
        callsite: 'unavailable',
        entryDetail: 'exact',
        origin: 'exact',
        source: 'available'
      },
      operation: 'runtime.module.import',
      origin: input.targetUrl,
      requestId,
      schemaVersion: 1,
      source: input.source,
      sourceBytes,
      sourceSha256: createHash('sha256').update(input.source).digest('hex')
    }
  })
  if ((await decision).action !== 'allow') throw new TypeError('Node Runtime dynamic import was denied')
}

const settleEngineGate = command => {
  const requestId = command.value?.requestId
  const action = command.value?.action
  const resolve = engineGatePending.get(requestId)
  if (resolve == null || !['allow', 'deny'].includes(action)) return
  engineGatePending.delete(requestId)
  resolve(Object.freeze({ action }))
}

const status = () => ({
  engineGate: runtimeContext == null
    ? null
    : Object.freeze({ mode: runtimeContext.engineGate.mode, ...runtimeContext.engineGate.snapshot() }),
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
    observe('runtime.exception', { code: 'runtime.entry_evaluation_failed' })
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
    dynamicImportOperations = 0
    networkRules = session.networkRules
    pluginGraphRevision = session.pluginGraphRevision
    stage = 'runtime_context'
    runtimeContext = createRuntimeContext(
      `holonomy-runtime-${generation}`,
      session.capabilityRuntime?.runtimeCreation.configuration.sandboxPolicy.codeGeneration
    )
    stage = 'module_graph'
    graph = new SessionModuleGraph(runtimeContext, session, {
      gateDynamicImport: input => gateDynamicImport(input, session),
      observeScriptCompiled
    })
    stage = 'host_bridge'
    hostController = new NodeRuntimeHostController({
      onTerminate: code => {
        // This OS process is the Runtime generation's terminal boundary. A
        // synchronous exit must preempt already queued Guest Promise jobs.
        process.exit(code)
      },
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
  observe('runtime.terminated', { reason: 'stopped' })
  await hostController?.dispose().catch(() => undefined)
  for (const resolve of engineGatePending.values()) resolve(Object.freeze({ action: 'deny' }))
  engineGatePending.clear()
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
  ['engineGateDecision', 'plugins', 'resume', 'rules', 'start', 'status', 'stop'].includes(command.type)

process.on('message', command => {
  void (async () => {
    if (!validCommand(command)) return
    if (command.type !== 'start' && command.generation !== generation) return
    if (command.type === 'start') return start(command)
    if (command.type === 'engineGateDecision') return settleEngineGate(command)
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
    observe('runtime.terminated', { reason: 'lost' })
    state = 'stopping'
    await hostController?.dispose().catch(() => undefined)
    graph = undefined
    hostController = undefined
    runtimeContext = undefined
    process.exit(1)
  })()
})

process.on('uncaughtException', () => {
  observe('runtime.exception', { code: 'runtime.uncaught_exception' })
  void emit('fatal', { code: 'uncaught_exception' }).finally(() => process.exit(1))
})

process.on('unhandledRejection', () => {
  observe('runtime.exception', { code: 'runtime.unhandled_rejection' })
  void emit('fatal', { code: 'unhandled_rejection' }).finally(() => process.exit(1))
})
