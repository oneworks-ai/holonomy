import { invalidPolicy } from './errors.js'
import { boundedText, deepFreeze, exact, integer, literal, required } from './validation.js'

import type {
  EngineGateDecisionV1,
  EngineGateOperationV1,
  EngineGateRequestMetadataV1,
  EngineHookCapabilityProbeV1
} from './engine-types.js'

export type {
  EngineGateDecisionV1,
  EngineGateMetadataSupportV1,
  EngineGateOperationV1,
  EngineGateRequestMetadataV1,
  EngineHookCapabilityProbeV1
} from './engine-types.js'

const availability = ['available', 'exact', 'unavailable'] as const

const digest = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) return invalidPolicy()
  return value
}

const opaqueId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[\w.:-]{1,128}$/u.test(value)) return invalidPolicy()
  return value
}

export const normalizeEngineGateRequestMetadataV1 = (
  value: unknown
): EngineGateRequestMetadataV1 => {
  const input = exact(value, [
    'callsite',
    'codeKind',
    'entryDetail',
    'metadataSupport',
    'operation',
    'origin',
    'requestId',
    'runtime',
    'schemaVersion',
    'sourceBytes',
    'sourceSha256'
  ])
  if (required(input, 'schemaVersion') !== 1) return invalidPolicy()
  const metadataInput = exact(required(input, 'metadataSupport'), [
    'callsite',
    'entryDetail',
    'origin',
    'source'
  ])
  const metadataSupport = Object.freeze({
    callsite: literal(required(metadataInput, 'callsite'), ['exact', 'unavailable'] as const),
    entryDetail: literal(required(metadataInput, 'entryDetail'), ['exact', 'unavailable'] as const),
    origin: literal(required(metadataInput, 'origin'), ['exact', 'unavailable'] as const),
    source: literal(required(metadataInput, 'source'), ['available', 'unavailable'] as const)
  })
  const operation = literal(required(input, 'operation'), ENGINE_GATE_OPERATIONS_V1)
  const codeKind = literal(required(input, 'codeKind'), ['module', 'strings', 'wasm'] as const)
  if (
    (operation === 'runtime.code.generate.strings' && codeKind !== 'strings') ||
    (operation === 'runtime.code.generate.wasm' && codeKind !== 'wasm') ||
    (operation === 'runtime.module.import' && codeKind !== 'module')
  ) return invalidPolicy()
  const output: Record<string, unknown> = {
    codeKind,
    metadataSupport,
    operation,
    requestId: opaqueId(required(input, 'requestId')),
    schemaVersion: 1
  }
  const runtime = exact(required(input, 'runtime'), ['generation', 'policyDigest', 'processId'])
  output.runtime = Object.freeze({
    generation: integer(required(runtime, 'generation'), 1, Number.MAX_SAFE_INTEGER),
    policyDigest: digest(required(runtime, 'policyDigest')),
    processId: opaqueId(required(runtime, 'processId'))
  })
  if (metadataSupport.source === 'available') {
    output.sourceBytes = integer(required(input, 'sourceBytes'), 0, 16 * 1024 * 1024)
    output.sourceSha256 = digest(required(input, 'sourceSha256'))
  } else if (Object.hasOwn(input, 'sourceBytes') || Object.hasOwn(input, 'sourceSha256')) return invalidPolicy()
  if (metadataSupport.origin === 'exact') output.origin = boundedText(required(input, 'origin'), 4096)
  else if (Object.hasOwn(input, 'origin')) return invalidPolicy()
  if (metadataSupport.entryDetail === 'exact') {
    const detail = exact(required(input, 'entryDetail'), ['kind', 'source'])
    output.entryDetail = Object.freeze({
      kind: literal(
        required(detail, 'kind'),
        [
          'debuggerSetScriptSource',
          'dynamicImport',
          'inspectorCallFunction',
          'inspectorCompile',
          'inspectorEvaluate',
          'inspectorRunScript'
        ] as const
      ),
      source: literal(required(detail, 'source'), ['inspector', 'loader', 'trustedWrapper'] as const)
    })
  } else if (Object.hasOwn(input, 'entryDetail')) return invalidPolicy()
  if (metadataSupport.callsite === 'exact') {
    const callsite = exact(required(input, 'callsite'), ['column', 'line', 'moduleUrl'])
    const normalized: Record<string, unknown> = {
      moduleUrl: boundedText(required(callsite, 'moduleUrl'), 4096)
    }
    if (Object.hasOwn(callsite, 'line')) normalized.line = integer(callsite.line, 1, 10_000_000)
    if (Object.hasOwn(callsite, 'column')) normalized.column = integer(callsite.column, 1, 10_000_000)
    output.callsite = Object.freeze(normalized)
  } else if (Object.hasOwn(input, 'callsite')) return invalidPolicy()
  return deepFreeze(output) as unknown as EngineGateRequestMetadataV1
}

export const normalizeEngineGateDecisionV1 = (value: unknown): EngineGateDecisionV1 => {
  const input = exact(value, ['action', 'reasonCode'])
  const action = literal(required(input, 'action'), ['allow', 'deny'] as const)
  if (action === 'allow') {
    if (Object.hasOwn(input, 'reasonCode')) return invalidPolicy()
    return Object.freeze({ action })
  }
  return Object.freeze({ action, reasonCode: opaqueId(required(input, 'reasonCode')) })
}

export const normalizeEngineHookCapabilityProbeV1 = (
  value: unknown
): EngineHookCapabilityProbeV1 => {
  const input = exact(value, [
    'engine',
    'metadata',
    'provenance',
    'schemaVersion',
    'strings',
    'wasm'
  ])
  if (required(input, 'schemaVersion') !== 1) return invalidPolicy()
  const metadataInput = exact(required(input, 'metadata'), [
    'callsite',
    'entryDetail',
    'origin',
    'source'
  ])
  const flagSet = (item: unknown) => {
    const flags = exact(item, ['generationLevelDeny', 'perCompilationCallback'])
    if (typeof required(flags, 'generationLevelDeny') !== 'boolean') return invalidPolicy()
    if (typeof required(flags, 'perCompilationCallback') !== 'boolean') return invalidPolicy()
    return Object.freeze({
      generationLevelDeny: flags.generationLevelDeny as boolean,
      perCompilationCallback: flags.perCompilationCallback as boolean
    })
  }
  const provenanceInput = exact(required(input, 'provenance'), [
    'generationLevel',
    'metadata',
    'perCompilationCallback'
  ])
  return deepFreeze({
    engine: literal(required(input, 'engine'), ['android-embedded-v8', 'node-vm'] as const),
    metadata: {
      callsite: literal(required(metadataInput, 'callsite'), availability.filter(value => value !== 'available')),
      entryDetail: literal(required(metadataInput, 'entryDetail'), availability.filter(value => value !== 'available')),
      origin: literal(required(metadataInput, 'origin'), availability.filter(value => value !== 'available')),
      source: literal(required(metadataInput, 'source'), ['available', 'unavailable'] as const)
    },
    provenance: {
      generationLevel: literal(required(provenanceInput, 'generationLevel'), ['behavioralProbe'] as const),
      metadata: literal(required(provenanceInput, 'metadata'), ['profileStaticUnsupported'] as const),
      perCompilationCallback: literal(
        required(provenanceInput, 'perCompilationCallback'),
        ['profileStaticUnsupported'] as const
      )
    },
    schemaVersion: 1,
    strings: flagSet(required(input, 'strings')),
    wasm: flagSet(required(input, 'wasm'))
  })
}

export const ENGINE_GATE_OPERATIONS_V1 = Object.freeze(
  [
    'runtime.code.generate.strings',
    'runtime.code.generate.wasm',
    'runtime.module.import'
  ] as const satisfies readonly EngineGateOperationV1[]
)
