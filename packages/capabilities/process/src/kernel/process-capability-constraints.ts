import { invalidPolicy } from '@holonomyjs/runtime/kernel/errors'
import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import type { BuiltInCapabilityNameV1 } from '@holonomyjs/runtime/kernel/operation-types'
import { array, exact, identifier, integer, literal, required, stringSet } from '@holonomyjs/runtime/kernel/validation'

type Constraints = Readonly<Record<string, JsonValueV1>>

const PROCESS_LIMITS = [
  'maxConcurrentProcesses',
  'maxExecutionTimeMs',
  'maxOpenPipes',
  'maxProcessTreeDepth',
  'maxStderrBytes',
  'maxStdinBytes',
  'maxStdoutBytes',
  'maxTotalProcesses',
  'maxWritableRootfsBytes'
] as const

const identifiers = (value: unknown, maximum: number) => {
  const values = array(value, 0, maximum).map(item => identifier(item, 128)).sort()
  if (new Set(values).size !== values.length) return invalidPolicy()
  return Object.freeze(values)
}

const limits = (value: unknown) => {
  const input = exact(value, PROCESS_LIMITS)
  return Object.freeze(Object.fromEntries(PROCESS_LIMITS.map(key => [
    key,
    integer(required(input, key), 0, 4 * 1024 * 1024 * 1024)
  ]))) as Constraints
}

const hostname = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return invalidPolicy()
  const normalized = value.toLowerCase()
  try {
    const url = new URL(`http://${normalized}/`)
    if (url.hostname !== normalized || url.port !== '' || url.username !== '' || url.password !== '') {
      return invalidPolicy()
    }
  } catch {
    return invalidPolicy()
  }
  return normalized
}

const network = (value: unknown): Constraints => {
  const input = exact(value, ['endpoints', 'maxSockets'])
  const endpoints = array(required(input, 'endpoints'), 0, 256).map(value => {
    const endpoint = exact(value, ['hostname', 'ports', 'transport'])
    const ports = array(required(endpoint, 'ports'), 1, 64)
      .map(port => integer(port, 1, 65_535)).sort((left, right) => left - right)
    if (new Set(ports).size !== ports.length) return invalidPolicy()
    return Object.freeze({
      hostname: hostname(required(endpoint, 'hostname')),
      ports: Object.freeze(ports),
      transport: literal(required(endpoint, 'transport'), ['tcp', 'tls', 'udp'] as const)
    })
  }).sort((left, right) => `${left.transport}\0${left.hostname}`.localeCompare(`${right.transport}\0${right.hostname}`))
  const identities = endpoints.map(endpoint => `${endpoint.transport}\0${endpoint.hostname}`)
  if (new Set(identities).size !== identities.length) return invalidPolicy()
  return Object.freeze({
    endpoints: Object.freeze(endpoints),
    maxSockets: integer(required(input, 'maxSockets'), 1, 256)
  }) as Constraints
}

export const normalizeProcessCapabilityConstraintsV1 = (
  name: BuiltInCapabilityNameV1,
  value: unknown
): Constraints => {
  if (name === 'host.process.network') return network(value)
  const keys = name === 'host.process.execute'
    ? ['executableIds', 'limits', 'rootIds']
    : name === 'host.process.shell'
    ? ['executableIds']
    : name === 'host.process.signal'
    ? ['signals']
    : ['executableIds', 'maxProcesses', 'signals']
  const input = exact(value, keys)
  if (name === 'host.process.execute') {
    return Object.freeze({
      executableIds: identifiers(required(input, 'executableIds'), 256),
      limits: limits(required(input, 'limits')),
      rootIds: identifiers(required(input, 'rootIds'), 64)
    })
  }
  if (name === 'host.process.shell') {
    return Object.freeze({ executableIds: identifiers(required(input, 'executableIds'), 256) })
  }
  if (name === 'host.process.signal') {
    return Object.freeze({
      signals: stringSet(required(input, 'signals'), ['SIGINT', 'SIGKILL', 'SIGTERM'] as const, 0, 3)
    })
  }
  return Object.freeze({
    executableIds: identifiers(required(input, 'executableIds'), 256),
    maxProcesses: integer(required(input, 'maxProcesses'), 0, 100_000),
    signals: stringSet(required(input, 'signals'), ['SIGINT', 'SIGKILL', 'SIGTERM'] as const, 0, 3)
  })
}
