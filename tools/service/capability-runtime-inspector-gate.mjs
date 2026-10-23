import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'

import {
  normalizeEngineGateDecisionV1,
  normalizeEngineGateRequestMetadataV1
} from '../../dist/capability-runtime/index.js'

const COMMANDS = Object.freeze({
  'Debugger.evaluateOnCallFrame': Object.freeze({
    detail: 'inspectorEvaluate',
    policy: 'evaluate',
    source: 'expression'
  }),
  'Debugger.setScriptSource': Object.freeze({
    detail: 'debuggerSetScriptSource',
    policy: 'setScriptSource',
    source: 'scriptSource'
  }),
  'Runtime.callFunctionOn': Object.freeze({
    detail: 'inspectorCallFunction',
    policy: 'callFunctionOn',
    source: 'functionDeclaration'
  }),
  'Runtime.compileScript': Object.freeze({
    detail: 'inspectorCompile',
    origin: 'sourceURL',
    policy: 'compileScript',
    source: 'expression'
  }),
  'Runtime.evaluate': Object.freeze({
    detail: 'inspectorEvaluate',
    policy: 'evaluate',
    source: 'expression'
  }),
  'Runtime.runScript': Object.freeze({
    detail: 'inspectorRunScript',
    policy: 'runScript'
  })
})

const deny = () => Object.freeze({ action: 'deny', reasonCode: 'inspector.policy_denied' })

const createSourceReader = (source, context, hostCaps, signal) => {
  const bytes = source == null ? undefined : Buffer.from(source)
  const limit = Math.min(
    context.diagnostics?.sourceReader === 'boundedSource' ? context.diagnostics.maxSourceReadBytes : 0,
    hostCaps?.capabilityName === 'host.diagnostics.source.read' ? hostCaps.maxReadBytes : 0,
    bytes?.byteLength ?? 0
  )
  if (bytes == null || limit < 1) return undefined
  let active = true
  let consumed = false
  return {
    close: () => active = false,
    reader: Object.freeze({
      read: async options => {
        if (
          !active || consumed || signal.aborted || options == null || typeof options !== 'object' ||
          Array.isArray(options) || Object.keys(options).some(key => key !== 'maxBytes') ||
          !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1
        ) {
          throw Object.assign(new Error('Engine source reader is unavailable'), {
            code: 'engine_source_reader_unavailable'
          })
        }
        consumed = true
        return Uint8Array.from(bytes.subarray(0, Math.min(options.maxBytes, limit)))
      }
    })
  }
}

export const gateInspectorCdpCommandV1 = async ({ context, engineGate, isCurrent, message, sourceReaderHostCaps }) => {
  const descriptor = COMMANDS[message.method]
  if (descriptor == null) return true
  const policy = context?.policy
  const strings = context?.codeGeneration
  if (
    policy?.[descriptor.policy] !== true || strings?.access !== 'controlled' ||
    typeof engineGate !== 'function'
  ) return false
  const source = descriptor.source == null ? undefined : message.params?.[descriptor.source]
  if (descriptor.source != null && typeof source !== 'string') return false
  const sourceBytes = source == null ? undefined : Buffer.byteLength(source)
  if (sourceBytes != null && sourceBytes > strings.maxSourceBytes) return false
  const origin = descriptor.origin == null ? undefined : message.params?.[descriptor.origin]
  if (origin != null && (typeof origin !== 'string' || origin.length > 4096)) return false
  context.operations += 1
  if (context.operations > strings.maxOperations) return false
  const controller = new AbortController()
  const sourceReader = createSourceReader(source, context, sourceReaderHostCaps, controller.signal)
  const timeout = setTimeout(
    () =>
      controller.abort(Object.assign(new Error('Inspector Engine Gate timed out'), { code: 'engine_gate_timeout' })),
    strings.decisionTimeoutMs
  )
  const metadata = normalizeEngineGateRequestMetadataV1({
    codeKind: 'strings',
    entryDetail: { kind: descriptor.detail, source: 'inspector' },
    metadataSupport: {
      callsite: 'unavailable',
      entryDetail: 'exact',
      origin: origin == null ? 'unavailable' : 'exact',
      source: source == null ? 'unavailable' : 'available'
    },
    operation: 'runtime.code.generate.strings',
    ...(origin == null ? {} : { origin }),
    requestId: `inspector-${context.generation}-${randomUUID()}`,
    runtime: {
      generation: context.generation,
      policyDigest: context.policyDigest,
      processId: context.processId
    },
    schemaVersion: 1,
    ...(source == null
      ? {}
      : {
        sourceBytes,
        sourceSha256: createHash('sha256').update(source).digest('hex')
      })
  })
  try {
    const decision = await Promise.race([
      Promise.resolve(engineGate(Object.freeze({
        ...metadata,
        ...(sourceReader == null ? {} : { sourceReader: sourceReader.reader }),
        signal: controller.signal
      })))
        .then(value => normalizeEngineGateDecisionV1(value))
        .catch(deny),
      new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(deny()), { once: true }))
    ])
    return decision.action === 'allow' && isCurrent()
  } finally {
    clearTimeout(timeout)
    sourceReader?.close()
  }
}

export const inspectorEngineGateContextV1 = process => {
  const capability = process.capabilityRuntime
  if (capability == null) return undefined
  return {
    codeGeneration: capability.sandboxPolicy.codeGeneration.strings,
    diagnostics: capability.sandboxPolicy.diagnostics,
    generation: process.generation,
    operations: 0,
    policy: capability.sandboxPolicy.inspector,
    policyDigest: capability.policyDigest,
    processId: process.id
  }
}
