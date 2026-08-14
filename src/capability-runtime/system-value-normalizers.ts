import { invalidPolicy } from './errors.js'
import { normalizeCidr, normalizeIpAddress } from './system-addresses.js'
import type { NodeCpuInfoV1, NodeNetworkInterfaceInfoV1, NodeUserInfoV1 } from './system-types.js'
import { array, boolean, boundedText, exact, finiteNumber, integer, literal, record, required } from './validation.js'

const SAFE = Number.MAX_SAFE_INTEGER

export const normalizeCpuList = (value: unknown): readonly NodeCpuInfoV1[] =>
  Object.freeze(
    array(value, 0, 256).map(item => {
      const cpu = exact(item, ['model', 'speed', 'times'])
      const times = exact(required(cpu, 'times'), ['idle', 'irq', 'nice', 'sys', 'user'])
      return Object.freeze({
        model: boundedText(required(cpu, 'model'), 256),
        speed: integer(required(cpu, 'speed'), 0, 10_000_000),
        times: Object.freeze({
          idle: integer(required(times, 'idle'), 0, SAFE),
          irq: integer(required(times, 'irq'), 0, SAFE),
          nice: integer(required(times, 'nice'), 0, SAFE),
          sys: integer(required(times, 'sys'), 0, SAFE),
          user: integer(required(times, 'user'), 0, SAFE)
        })
      })
    })
  )

const normalizeInterface = (value: unknown): NodeNetworkInterfaceInfoV1 => {
  const input = exact(value, ['address', 'cidr', 'family', 'internal', 'mac', 'netmask', 'scopeid'])
  const family = literal(required(input, 'family'), ['IPv4', 'IPv6'] as const)
  const output = {
    address: normalizeIpAddress(required(input, 'address'), family),
    cidr: normalizeCidr(required(input, 'cidr'), family),
    family,
    internal: boolean(required(input, 'internal')),
    mac: boundedText(required(input, 'mac'), 17).toLowerCase(),
    netmask: normalizeIpAddress(required(input, 'netmask'), family),
    ...(Object.hasOwn(input, 'scopeid')
      ? { scopeid: integer(input.scopeid, 0, 0xFFFF_FFFF) }
      : {})
  }
  if (!/^(?:[\da-f]{2}:){5}[\da-f]{2}$/u.test(output.mac)) return invalidPolicy()
  if (family === 'IPv4' && output.scopeid !== undefined) return invalidPolicy()
  return Object.freeze(output)
}

export const normalizeInterfaces = (
  value: unknown
): Readonly<Record<string, readonly NodeNetworkInterfaceInfoV1[]>> => {
  const input = record(value)
  const keys = Object.keys(input).sort()
  if (keys.length > 32) return invalidPolicy()
  const output = Object.create(null) as Record<string, readonly NodeNetworkInterfaceInfoV1[]>
  for (const key of keys) {
    boundedText(key, 256)
    output[key] = Object.freeze(array(input[key], 0, 16).map(normalizeInterface))
  }
  return Object.freeze(output)
}

export const normalizeUserInfo = (value: unknown): NodeUserInfoV1 => {
  const input = exact(value, ['gid', 'homedir', 'shell', 'uid', 'username'])
  const signedId = (item: unknown) => item === -1 ? -1 : integer(item, 0, SAFE)
  const shell = required(input, 'shell')
  return Object.freeze({
    gid: signedId(required(input, 'gid')),
    homedir: normalizeVirtualPath(required(input, 'homedir')),
    shell: shell === null ? null : normalizeVirtualPath(shell),
    uid: signedId(required(input, 'uid')),
    username: boundedText(required(input, 'username'), 256)
  })
}

export const normalizeVirtualPath = (value: unknown): string => {
  const input = boundedText(value, 4096)
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return invalidPolicy()
  }
  if (parsed.protocol !== 'holo-fs:' || parsed.href !== input || !/^[a-z][\w.-]{0,63}$/u.test(parsed.hostname)) {
    return invalidPolicy()
  }
  return input
}

export const normalizeLoadAverage = (value: unknown): readonly [number, number, number] => {
  const values = array(value, 3, 3).map(item => finiteNumber(item, 0, SAFE))
  return Object.freeze(values) as readonly [number, number, number]
}
