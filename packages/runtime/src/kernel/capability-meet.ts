import { DEVICE_PRECISION_V1, SYSTEM_PRECISION_V1, normalizeCapabilityConstraintsV1 } from './capability-constraints.js'
import type { NormalizedCapabilityConstraintsV1 } from './capability-constraints.js'
import type { JsonValueV1 } from './json-types.js'
import type { BuiltInCapabilityNameV1 } from './operation-types.js'
import { deepFreeze } from './validation.js'

const intersect = (left: readonly string[], right: readonly string[]) =>
  Object.freeze(left.filter(value => right.includes(value)).sort())
const meetNumbers = (
  left: NormalizedCapabilityConstraintsV1,
  right: NormalizedCapabilityConstraintsV1
) =>
  Object.freeze(Object.fromEntries(
    Object.keys(left).map(key => [key, Math.min(left[key] as number, right[key] as number)])
  )) as NormalizedCapabilityConstraintsV1
const commonPrefix = (left: readonly string[], right: readonly string[]) => {
  if (left.length <= right.length && left.every((value, index) => value === right[index])) return right
  if (right.length <= left.length && right.every((value, index) => value === left[index])) return left
  return undefined
}

const meetFs = (
  left: NormalizedCapabilityConstraintsV1,
  right: NormalizedCapabilityConstraintsV1
): NormalizedCapabilityConstraintsV1 | null => {
  const roots: Record<string, JsonValueV1>[] = []
  for (const leftRoot of left.roots as readonly Record<string, JsonValueV1>[]) {
    for (const rightRoot of right.roots as readonly Record<string, JsonValueV1>[]) {
      if (leftRoot.rootId !== rightRoot.rootId) continue
      const pathPrefixSegments = commonPrefix(
        leftRoot.pathPrefixSegments as readonly string[],
        rightRoot.pathPrefixSegments as readonly string[]
      )
      const rights = intersect(
        leftRoot.rights as readonly string[],
        rightRoot.rights as readonly string[]
      )
      if (pathPrefixSegments === undefined || rights.length === 0) continue
      roots.push(Object.freeze({
        pathPrefixSegments,
        rights,
        rootId: leftRoot.rootId!,
        symlinks: leftRoot.symlinks === 'deny' || rightRoot.symlinks === 'deny' ? 'deny' : 'withinRoot'
      }))
    }
  }
  if (roots.length === 0) return null
  return deepFreeze({
    limits: meetNumbers(
      left.limits as NormalizedCapabilityConstraintsV1,
      right.limits as NormalizedCapabilityConstraintsV1
    ),
    roots
  })
}

const meetNetwork = (
  left: NormalizedCapabilityConstraintsV1,
  right: NormalizedCapabilityConstraintsV1
): NormalizedCapabilityConstraintsV1 | null => {
  if (left.mode !== right.mode) return null
  const origins = intersect(left.origins as readonly string[], right.origins as readonly string[])
  const schemes = intersect(left.schemes as readonly string[], right.schemes as readonly string[])
  if (origins.length === 0 || schemes.length === 0) return null
  return deepFreeze({
    allowPrivateNetwork: (left.allowPrivateNetwork as boolean) && (right.allowPrivateNetwork as boolean),
    inspectRequestBodyBytes: Math.min(
      left.inspectRequestBodyBytes as number,
      right.inspectRequestBodyBytes as number
    ),
    limits: meetNumbers(
      left.limits as NormalizedCapabilityConstraintsV1,
      right.limits as NormalizedCapabilityConstraintsV1
    ),
    mode: left.mode!,
    origins,
    schemes
  })
}

const meetProcessNetwork = (
  left: NormalizedCapabilityConstraintsV1,
  right: NormalizedCapabilityConstraintsV1
): NormalizedCapabilityConstraintsV1 | null => {
  const rightEndpoints = new Map(
    (right.endpoints as readonly Readonly<Record<string, JsonValueV1>>[]).map(endpoint => [
      `${endpoint.transport}\0${endpoint.hostname}`,
      endpoint
    ])
  )
  const endpoints = (left.endpoints as readonly Readonly<Record<string, JsonValueV1>>[]).flatMap(endpoint => {
    const other = rightEndpoints.get(`${endpoint.transport}\0${endpoint.hostname}`)
    if (other == null) return []
    const ports = (endpoint.ports as readonly number[]).filter(port =>
      (other.ports as readonly number[]).includes(port)
    )
    return ports.length === 0
      ? []
      : [Object.freeze({ hostname: endpoint.hostname!, ports: Object.freeze(ports), transport: endpoint.transport! })]
  })
  if (endpoints.length === 0) return null
  return deepFreeze({
    endpoints,
    maxSockets: Math.min(left.maxSockets as number, right.maxSockets as number)
  })
}

export const meetCapabilityConstraintsV1 = (
  name: BuiltInCapabilityNameV1,
  leftValue: unknown,
  rightValue: unknown
): NormalizedCapabilityConstraintsV1 | null => {
  const left = normalizeCapabilityConstraintsV1(name, leftValue)
  const right = normalizeCapabilityConstraintsV1(name, rightValue)
  if (name === 'host.fs') return meetFs(left, right)
  if (name === 'host.network.http' || name === 'host.network.mock') return meetNetwork(left, right)
  if (name === 'host.process.network') return meetProcessNetwork(left, right)
  if (name === 'host.process.execute') {
    const executableIds = intersect(left.executableIds as readonly string[], right.executableIds as readonly string[])
    const rootIds = intersect(left.rootIds as readonly string[], right.rootIds as readonly string[])
    if (
      executableIds.length === 0 && (left.executableIds as readonly string[]).length > 0 &&
      (right.executableIds as readonly string[]).length > 0
    ) return null
    return deepFreeze({
      executableIds,
      limits: meetNumbers(
        left.limits as NormalizedCapabilityConstraintsV1,
        right.limits as NormalizedCapabilityConstraintsV1
      ),
      rootIds
    })
  }
  const output: Record<string, JsonValueV1> = {}
  for (const key of Object.keys(left)) {
    const a = left[key]
    const b = right[key]
    if (Array.isArray(a) && Array.isArray(b)) {
      const values = intersect(a as readonly string[], b as readonly string[])
      if (values.length === 0 && a.length > 0 && b.length > 0) return null
      output[key] = values
    } else if (typeof a === 'number' && typeof b === 'number') output[key] = Math.min(a, b)
    else if (typeof a === 'boolean' && typeof b === 'boolean') output[key] = a && b
    else if (a === b) output[key] = a
    else if (key === 'maxPrecision') {
      const rank = name.startsWith('host.device.') ? DEVICE_PRECISION_V1 : SYSTEM_PRECISION_V1
      output[key] = rank[Math.min(rank.indexOf(a as never), rank.indexOf(b as never))]!
    } else return null
  }
  return deepFreeze(output)
}
