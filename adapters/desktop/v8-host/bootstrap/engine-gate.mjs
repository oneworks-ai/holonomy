import {
  canonicalDigest,
  normalizeEngineGateDecisionV1,
  normalizeEngineGateRequestMetadataV1
} from '../../../../packages/runtime/src/kernel/index.ts'
import { sha256Hex } from '../../../../packages/runtime/src/module-loader/sha256.ts'
import { NATIVE_INSPECTOR_METHODS as inspectorMethods } from './inspector-methods.mjs'

const parse = JSON.parse
const stringify = JSON.stringify
const NativeUint8Array = Uint8Array
const copyBytes = NativeUint8Array.from
const fillBytes = NativeUint8Array.prototype.fill
const subarrayBytes = NativeUint8Array.prototype.subarray
const min = Math.min
// Policy owns hard ceilings; the separate Gate registry belongs to the same plugin graph.
export const createNativeEngineGate = (policy, isAdmitted, registry, sourceReaderCaps, inspectorInstalled = false) => {
  const pending = new Map()
  let lastRequestId = 0
  let closed = false
  let sourceReads = 0
  const engineGateOperations = Object.seal({ strings: 0, wasm: 0, module: 0 })
  const engineGatePolicyDigest = canonicalDigest(policy)
  const engineGateDecision = (action, reasonCode, decisionTimeoutMs) =>
    stringify({
      decision: normalizeEngineGateDecisionV1(action === 'allow' ? { action } : { action, reasonCode }),
      decisionTimeoutMs
    })
  const gateEngineCode = async (encoded, sourcePrefix) => {
    const zeroSource = () => {
      if (sourcePrefix instanceof NativeUint8Array) fillBytes.call(sourcePrefix, 0)
    }
    const invalid = () => {
      zeroSource()
      return engineGateDecision('deny', 'runtime.invalid_request', 1)
    }
    let input
    try {
      input = parse(encoded)
    } catch {
      return invalid()
    }
    if (
      input == null || typeof input !== 'object' || Array.isArray(input) ||
      !Number.isSafeInteger(input.requestId) || input.requestId < 1
    ) return invalid()
    const inspector =
      typeof input.inspectorMethod === 'string' && Object.hasOwn(inspectorMethods, input.inspectorMethod)
        ? inspectorMethods[input.inspectorMethod]
        : undefined
    if (
      Object.hasOwn(input, 'inspectorMethod') && (
        !inspectorInstalled || inspector == null || input.codeKind !== 'strings' ||
        input.sourceAvailable !== inspector[2] ||
        Object.hasOwn(input, 'origin')
      )
    ) return invalid()
    const hasSource = inspector == null
      ? input.codeKind !== 'module' || input.sourceAvailable === true
      : input.sourceAvailable === true
    if (!hasSource && (Object.hasOwn(input, 'sourceBytes') || Object.hasOwn(input, 'sourceSha256'))) {
      return invalid()
    }
    if (
      hasSource && (!Number.isSafeInteger(input.sourceBytes) || input.sourceBytes < 0 ||
        input.sourceBytes > 16 * 1024 * 1024 || typeof input.sourceSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(input.sourceSha256))
    ) return invalid()
    if (
      input.codeKind === 'module' && (typeof input.sourceAvailable !== 'boolean' ||
        typeof input.origin !== 'string' || input.origin.length === 0 || input.origin.length > 4096)
    ) {
      return invalid()
    }
    if (Object.hasOwn(input, 'sourcePrefix')) return invalid()
    if (input.codeKind !== 'module' && Object.hasOwn(input, 'origin')) return invalid()
    if (sourcePrefix !== undefined) {
      if (
        !hasSource || !(sourcePrefix instanceof NativeUint8Array) || sourceReaderCaps.maxReadBytes < 1
      ) {
        return invalid()
      }
      if (
        sourcePrefix.length > sourceReaderCaps.maxReadBytes ||
        sourcePrefix.length > input.sourceBytes ||
        (sourcePrefix.length === input.sourceBytes && sha256Hex(sourcePrefix) !== input.sourceSha256)
      ) {
        return invalid()
      }
    }
    if (closed || input.requestId <= lastRequestId) return invalid()
    lastRequestId = input.requestId
    const kind = ['strings', 'wasm', 'module'].includes(input.codeKind) ? input.codeKind : null
    if (kind == null) return invalid()
    const configured = policy.codeGeneration[kind === 'module' ? 'dynamicImport' : kind]
    const request = normalizeEngineGateRequestMetadataV1({
      codeKind: kind,
      metadataSupport: {
        callsite: 'unavailable',
        entryDetail: kind === 'module' || inspector != null ? 'exact' : 'unavailable',
        origin: kind === 'module' ? 'exact' : 'unavailable',
        source: hasSource ? 'available' : 'unavailable'
      },
      operation: kind === 'module' ? 'runtime.module.import' : `runtime.code.generate.${kind}`,
      ...(kind === 'module' ? { origin: input.origin, entryDetail: { kind: 'dynamicImport', source: 'loader' } } : {}),
      ...(inspector == null ? {} : { entryDetail: { kind: inspector[1], source: 'inspector' } }),
      requestId: `desktop-${input.requestId}`,
      runtime: { generation: 1, policyDigest: engineGatePolicyDigest, processId: 'desktop-runtime' },
      schemaVersion: 1,
      ...(hasSource ? { sourceBytes: input.sourceBytes, sourceSha256: input.sourceSha256 } : {})
    })
    if (
      !isAdmitted() || configured.access !== 'controlled' ||
      (inspector != null && policy.inspector[inspector[0]] !== true)
    ) {
      zeroSource()
      return engineGateDecision('deny', 'runtime.policy_denied', 1)
    }
    engineGateOperations[kind] += 1
    if (engineGateOperations[kind] > configured.maxOperations) {
      zeroSource()
      return engineGateDecision('deny', 'runtime.operation_limit', configured.decisionTimeoutMs)
    }
    if (hasSource && request.sourceBytes > configured.maxSourceBytes) {
      zeroSource()
      return engineGateDecision('deny', 'runtime.source_limit', configured.decisionTimeoutMs)
    }
    const controller = new AbortController()
    let readerOpen = sourcePrefix != null && sourceReads < sourceReaderCaps.maxReads
    const copies = []
    const revoke = () => {
      readerOpen = false
      zeroSource()
      for (const bytes of copies) fillBytes.call(bytes, 0)
      copies.length = 0
    }
    if (!readerOpen) zeroSource()
    pending.set(String(input.requestId), { controller, revoke })
    const sourceReader = readerOpen
      ? Object.freeze({
        read: async options => {
          const descriptor = options != null && typeof options === 'object' && !Array.isArray(options)
            ? Object.getOwnPropertyDescriptors(options)
            : undefined
          if (
            !readerOpen || closed || controller.signal.aborted ||
            pending.get(String(input.requestId))?.controller !== controller ||
            sourceReads >= sourceReaderCaps.maxReads ||
            descriptor == null || Reflect.ownKeys(descriptor).length !== 1 ||
            descriptor.maxBytes == null || !Object.hasOwn(descriptor.maxBytes, 'value') ||
            !Number.isSafeInteger(descriptor.maxBytes.value) || descriptor.maxBytes.value < 1
          ) throw new Error('engine_source_reader_unavailable')
          readerOpen = false
          sourceReads += 1
          const readBytes = min(descriptor.maxBytes.value, sourceReaderCaps.maxReadBytes, sourcePrefix.length)
          if (sourceReaderCaps.auditRead?.(input, readBytes) === false) {
            throw new Error('engine_source_reader_unavailable')
          }
          const bytes = copyBytes.call(NativeUint8Array, subarrayBytes.call(sourcePrefix, 0, readBytes))
          copies.push(bytes)
          zeroSource()
          return bytes
        }
      })
      : undefined
    try {
      const decision = await registry.decide(request, controller.signal, sourceReader)
      return engineGateDecision(decision.action, decision.reasonCode, configured.decisionTimeoutMs)
    } catch {
      return engineGateDecision('deny', 'host.gate_failed', configured.decisionTimeoutMs)
    } finally {
      revoke()
      pending.delete(String(input.requestId))
    }
  }
  return Object.freeze({
    decide: gateEngineCode,
    cancel: id => {
      const record = pending.get(id)
      record?.controller.abort()
      record?.revoke()
    },
    close: () => {
      closed = true
      for (const record of pending.values()) {
        record.controller.abort()
        record.revoke()
      }
    }
  })
}
