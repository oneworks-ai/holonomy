import type {
  HoloInvocationContextV1,
  HoloInvocationMatcherV1,
  HoloMiddlewareRegistrationV1,
  InitialMiddlewareSetV1
} from './broker-types.js'
import { invalidPolicy } from './errors.js'

const invocationModes = new Set(['callback', 'promise', 'sync'])
const operationKinds = new Set(['close', 'invoke', 'open', 'read', 'subscribe', 'write'])
const phases = new Set(['requested', 'resolved'])
const resourceKinds = new Set([
  'deviceField',
  'filesystem',
  'network',
  'opaqueHandle',
  'processExecutable',
  'processInstance',
  'systemField'
])

const text = (value: unknown, maximum = 256): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) return invalidPolicy()
  return value
}

const normalizeMatcher = (value: HoloInvocationMatcherV1): HoloInvocationMatcherV1 => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalidPolicy()
  const allowed = ['invocationMode', 'kind', 'member', 'module', 'operation', 'phase', 'resource', 'source']
  if (Object.keys(value).some(key => !allowed.includes(key))) return invalidPolicy()
  if (value.invocationMode != null && !invocationModes.has(value.invocationMode)) return invalidPolicy()
  if (value.kind != null && !operationKinds.has(value.kind)) return invalidPolicy()
  if (value.phase != null && !phases.has(value.phase)) return invalidPolicy()
  if (value.resource?.kind != null && !resourceKinds.has(value.resource.kind)) return invalidPolicy()
  if (value.resource?.pathPrefixSegments != null && !Array.isArray(value.resource.pathPrefixSegments)) {
    return invalidPolicy()
  }
  const resource = value.resource == null
    ? undefined
    : Object.freeze({
      ...(value.resource.kind == null ? {} : { kind: value.resource.kind }),
      ...(value.resource.operation == null ? {} : { operation: text(value.resource.operation) }),
      ...(value.resource.origin == null ? {} : { origin: text(value.resource.origin, 4096) }),
      ...(value.resource.pathPrefixSegments == null
        ? {}
        : { pathPrefixSegments: Object.freeze(value.resource.pathPrefixSegments.map(item => text(item))) }),
      ...(value.resource.rootId == null ? {} : { rootId: text(value.resource.rootId) }),
      ...(value.resource.semanticId == null ? {} : { semanticId: text(value.resource.semanticId, 4096) })
    })
  const source = value.source == null
    ? undefined
    : (() => {
      if (
        typeof value.source !== 'object' || Array.isArray(value.source) ||
        Object.keys(value.source).some(key => !['environmentScope', 'executableId', 'kind'].includes(key)) ||
        value.source.kind != null && value.source.kind !== 'linuxProcess' ||
        value.source.environmentScope != null &&
          !['processTree', 'runtime'].includes(value.source.environmentScope)
      ) return invalidPolicy()
      return Object.freeze({
        ...(value.source.environmentScope == null ? {} : { environmentScope: value.source.environmentScope }),
        ...(value.source.executableId == null ? {} : { executableId: text(value.source.executableId) }),
        ...(value.source.kind == null ? {} : { kind: value.source.kind })
      })
    })()
  return Object.freeze({
    ...(value.invocationMode == null ? {} : { invocationMode: value.invocationMode }),
    ...(value.kind == null ? {} : { kind: value.kind }),
    ...(value.member == null ? {} : { member: text(value.member) }),
    ...(value.module == null ? {} : { module: text(value.module) }),
    ...(value.operation == null ? {} : { operation: text(value.operation) }),
    ...(value.phase == null ? {} : { phase: value.phase }),
    ...(resource == null ? {} : { resource }),
    ...(source == null ? {} : { source })
  })
}

const matchesResource = <THostContext>(
  matcher: NonNullable<HoloInvocationMatcherV1['resource']>,
  context: HoloInvocationContextV1<THostContext>
): boolean => {
  const resource = context.resource.resolved ?? context.resource.requested
  if (matcher.kind != null && resource.kind !== matcher.kind) return false
  if (matcher.semanticId != null && resource.semanticId !== matcher.semanticId) return false
  if (matcher.operation != null && resource.kind === 'deviceField' && resource.operation !== matcher.operation) {
    return false
  }
  if (matcher.operation != null && resource.kind !== 'deviceField') return false
  if (matcher.origin != null && resource.kind === 'network' && resource.origin !== matcher.origin) return false
  if (matcher.origin != null && resource.kind !== 'network') return false
  if (matcher.rootId != null && resource.kind === 'filesystem' && resource.rootId !== matcher.rootId) return false
  if (matcher.rootId != null && resource.kind !== 'filesystem') return false
  if (matcher.pathPrefixSegments != null) {
    if (resource.kind !== 'filesystem') return false
    if (!matcher.pathPrefixSegments.every((part, index) => resource.pathSegments[index] === part)) return false
  }
  return true
}

export const matchesHoloInvocationV1 = <THostContext>(
  matcher: HoloInvocationMatcherV1,
  context: HoloInvocationContextV1<THostContext>
): boolean =>
  (matcher.invocationMode == null || matcher.invocationMode === context.invocationMode) &&
  (matcher.kind == null || matcher.kind === context.kind) &&
  (matcher.member == null || matcher.member === context.member) &&
  (matcher.module == null || matcher.module === context.module) &&
  (matcher.operation == null || matcher.operation === context.operation) &&
  (matcher.phase == null || matcher.phase === context.phase) &&
  (matcher.resource == null || matchesResource(matcher.resource, context)) &&
  (matcher.source == null || context.source != null &&
      (matcher.source.kind == null || matcher.source.kind === context.source.kind) &&
      (matcher.source.executableId == null || matcher.source.executableId === context.source.executableId) &&
      (matcher.source.environmentScope == null ||
        matcher.source.environmentScope === context.source.environmentScope))

export const compileInitialMiddlewareSetV1 = <THostContext>(
  value: InitialMiddlewareSetV1<THostContext>
): InitialMiddlewareSetV1<THostContext> => {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.registrations)) return invalidPolicy()
  const ids = new Set<string>()
  const registrations = value.registrations.map(registration => {
    const id = text(registration.registrationId)
    if (ids.has(id) || typeof registration.middleware !== 'function') return invalidPolicy()
    ids.add(id)
    if (!['application', 'embedder'].includes(registration.layer)) return invalidPolicy()
    if (!['async', 'sync'].includes(registration.execution)) return invalidPolicy()
    if (
      registration.timeoutMs != null &&
      (!Number.isInteger(registration.timeoutMs) || registration.timeoutMs < 1 || registration.timeoutMs > 120_000)
    ) {
      return invalidPolicy()
    }
    return Object.freeze({
      execution: registration.execution,
      layer: registration.layer,
      matcher: normalizeMatcher(registration.matcher),
      middleware: registration.middleware,
      registrationId: id,
      ...(registration.timeoutMs == null ? {} : { timeoutMs: registration.timeoutMs })
    }) as HoloMiddlewareRegistrationV1<THostContext>
  })
  return Object.freeze({ registrations: Object.freeze(registrations), schemaVersion: 1 })
}
