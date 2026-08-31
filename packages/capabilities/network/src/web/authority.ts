/* eslint-disable max-lines -- URL authority and strict IP classification form one security boundary. */

import { createWebNetworkError } from './errors.js'

import type { NetworkAuthority, NetworkLimits, NetworkScheme, ResolvedNetworkAuthority } from './types.js'

export const DEFAULT_NETWORK_LIMITS: NetworkLimits = Object.freeze({
  maxChunkBytes: 64 * 1024,
  maxConcurrentConnections: 8,
  maxHeaderBytes: 64 * 1024,
  maxHeaders: 128,
  maxRedirects: 10,
  maxRequestBodyBytes: 1024 * 1024,
  maxResponseBodyBytes: 8 * 1024 * 1024,
  maxWebSocketBufferedBytes: 1024 * 1024,
  maxWebSocketMessageBytes: 1024 * 1024
})

const NETWORK_SCHEMES = new Set<NetworkScheme>(['http', 'https', 'ws', 'wss'])
const NON_PUBLIC_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8],
  [0x0A000000, 8],
  [0x64400000, 10],
  [0x7F000000, 8],
  [0xA9FE0000, 16],
  [0xAC100000, 12],
  [0xC0000000, 24],
  [0xC0000200, 24],
  [0xC0586300, 24],
  [0xC0A80000, 16],
  [0xC6120000, 15],
  [0xC6336400, 24],
  [0xCB007100, 24],
  [0xE0000000, 4],
  [0xF0000000, 4]
]

const parseIpv4 = (input: string) => {
  const parts = input.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  let value = 0
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return undefined
    const byte = Number(part)
    if (byte > 255) return undefined
    octets.push(byte)
    value = (value * 256) + byte
  }
  return { normalized: octets.join('.'), value: value >>> 0 }
}

const isPublicIpv4Value = (value: number) => (
  !NON_PUBLIC_IPV4_RANGES.some(([base, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
    return (value & mask) === (base & mask)
  })
)

const parseIpv6 = (input: string) => {
  if (input === '' || input.includes('%') || input.includes('[') || input.includes(']')) return undefined
  const normalized = input.toLowerCase()
  if (!/^[0-9a-f:.]+$/u.test(normalized)) return undefined
  const compression = normalized.indexOf('::')
  if (compression !== -1 && compression !== normalized.lastIndexOf('::')) return undefined
  const readParts = (value: string) => value === '' ? [] : value.split(':')
  const left = readParts(compression === -1 ? normalized : normalized.slice(0, compression))
  const right = readParts(compression === -1 ? '' : normalized.slice(compression + 2))
  const combined = [...left, ...right]
  const groups: number[] = []
  for (let index = 0; index < combined.length; index += 1) {
    const part = combined[index]!
    if (part.includes('.')) {
      if (index !== combined.length - 1) return undefined
      const ipv4 = parseIpv4(part)
      if (ipv4 == null) return undefined
      groups.push((ipv4.value >>> 16) & 0xFFFF, ipv4.value & 0xFFFF)
    } else {
      if (!/^[0-9a-f]{1,4}$/u.test(part)) return undefined
      groups.push(Number.parseInt(part, 16))
    }
  }
  if (compression === -1) {
    if (groups.length !== 8) return undefined
    return groups
  }
  if (groups.length >= 8) return undefined
  const leftGroupCount = left.reduce((count, part) => count + (part.includes('.') ? 2 : 1), 0)
  return [
    ...groups.slice(0, leftGroupCount),
    ...Array.from({ length: 8 - groups.length }, () => 0),
    ...groups.slice(leftGroupCount)
  ]
}

interface Ipv6Prefix {
  base: readonly number[]
  bits: number
}

const parseIpv6Prefix = (input: string, bits: number): Ipv6Prefix => {
  const base = parseIpv6(input)
  if (base == null) throw new Error('invalid static IPv6 prefix')
  return { base, bits }
}

/** IANA IPv6 Special-Purpose Address Registry prefixes; deny unless policy opts into non-public IPs. */
const NON_PUBLIC_IPV6_PREFIXES: readonly Ipv6Prefix[] = [
  parseIpv6Prefix('::', 128),
  parseIpv6Prefix('::1', 128),
  parseIpv6Prefix('::ffff:0:0', 96),
  parseIpv6Prefix('64:ff9b::', 96),
  parseIpv6Prefix('64:ff9b:1::', 48),
  parseIpv6Prefix('100::', 64),
  parseIpv6Prefix('100:0:0:1::', 64),
  parseIpv6Prefix('2001::', 23),
  parseIpv6Prefix('2001:2::', 48),
  parseIpv6Prefix('2001:3::', 32),
  parseIpv6Prefix('2001:4:112::', 48),
  parseIpv6Prefix('2001:10::', 28),
  parseIpv6Prefix('2001:20::', 28),
  parseIpv6Prefix('2001:30::', 28),
  parseIpv6Prefix('2001:db8::', 32),
  parseIpv6Prefix('2002::', 16),
  parseIpv6Prefix('2620:4f:8000::', 48),
  parseIpv6Prefix('3fff::', 20),
  parseIpv6Prefix('5f00::', 16),
  parseIpv6Prefix('fc00::', 7),
  parseIpv6Prefix('fe80::', 10),
  parseIpv6Prefix('ff00::', 8)
]

const matchesIpv6Prefix = (groups: readonly number[], prefix: Ipv6Prefix) => {
  const fullGroups = Math.floor(prefix.bits / 16)
  for (let index = 0; index < fullGroups; index += 1) {
    if (groups[index] !== prefix.base[index]) return false
  }
  const remaining = prefix.bits % 16
  if (remaining === 0) return true
  const mask = (0xFFFF << (16 - remaining)) & 0xFFFF
  return (groups[fullGroups]! & mask) === (prefix.base[fullGroups]! & mask)
}

const isPublicIpv6 = (groups: readonly number[]) => {
  return (groups[0]! & 0xE000) === 0x2000 &&
    !NON_PUBLIC_IPV6_PREFIXES.some(prefix => matchesIpv6Prefix(groups, prefix))
}

const parseAddress = (input: string) => {
  const ipv4 = parseIpv4(input)
  if (ipv4 != null) return { normalized: ipv4.normalized, public: isPublicIpv4Value(ipv4.value) }
  const ipv6 = parseIpv6(input)
  if (ipv6 == null) return undefined
  const normalized = new URL(`http://[${input}]/`).hostname.slice(1, -1)
  return { normalized, public: isPublicIpv6(ipv6) }
}

export const isPrivateNetworkHost = (input: string) => {
  const bracketed = input.startsWith('[') && input.endsWith(']')
  const host = (bracketed ? input.slice(1, -1) : input).toLowerCase().replace(/\.$/u, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const address = parseAddress(host)
  return address != null && !address.public
}

const resolveOrigin = (input: string) => {
  try {
    const url = new URL(input)
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) throw new Error('invalid origin')
    const scheme = url.protocol.slice(0, -1) as NetworkScheme
    if (!NETWORK_SCHEMES.has(scheme)) throw new Error('invalid scheme')
    return url.origin
  } catch {
    throw createWebNetworkError('network.invalid_url')
  }
}

const resolvePositiveLimit = (value: unknown) => (
  Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : undefined
)

export const resolveNetworkAuthority = (
  input: NetworkAuthority
): ResolvedNetworkAuthority => {
  try {
    if (input == null || typeof input !== 'object' || !Array.isArray(input.allowedOrigins)) {
      throw createWebNetworkError('network.invalid_url')
    }
    const allowAnyOrigin = input.allowedOrigins.includes('*')
    const origins = input.allowedOrigins
      .filter(origin => origin !== '*')
      .map(resolveOrigin)
    if (new Set(origins).size !== origins.length) {
      throw createWebNetworkError('network.invalid_url')
    }
    const schemes = input.allowedSchemes == null
      ? ['http', 'https'] satisfies NetworkScheme[]
      : [...input.allowedSchemes]
    if (
      schemes.length === 0 ||
      schemes.some(scheme => !NETWORK_SCHEMES.has(scheme)) ||
      new Set(schemes).size !== schemes.length
    ) throw createWebNetworkError('network.invalid_url')
    const limits = { ...DEFAULT_NETWORK_LIMITS, ...input.limits }
    if (Object.values(limits).some(value => resolvePositiveLimit(value) == null)) {
      throw createWebNetworkError('network.internal')
    }
    if (limits.maxChunkBytes > limits.maxRequestBodyBytes || limits.maxChunkBytes > limits.maxResponseBodyBytes) {
      throw createWebNetworkError('network.internal')
    }
    const privateNetwork = input.privateNetwork ?? 'deny'
    if (privateNetwork !== 'allow' && privateNetwork !== 'deny') {
      throw createWebNetworkError('network.internal')
    }
    return Object.freeze({
      allowedOrigins: Object.freeze(origins),
      allowedSchemes: Object.freeze(schemes),
      allowAnyOrigin,
      limits: Object.freeze(limits),
      privateNetwork
    })
  } catch (error) {
    throw error instanceof Error && 'code' in error
      ? error
      : createWebNetworkError('network.internal')
  }
}

export const authorizeNetworkUrl = (
  authority: ResolvedNetworkAuthority,
  input: string | URL,
  expected: 'http' | 'websocket'
) => {
  let url: URL
  try {
    url = new URL(input.toString())
  } catch {
    throw createWebNetworkError('network.invalid_url')
  }
  const scheme = url.protocol.slice(0, -1) as NetworkScheme
  const validExpected = expected === 'http'
    ? scheme === 'http' || scheme === 'https'
    : scheme === 'ws' || scheme === 'wss'
  if (
    !validExpected ||
    !authority.allowedSchemes.includes(scheme) ||
    url.username !== '' ||
    url.password !== '' ||
    (!authority.allowAnyOrigin && !authority.allowedOrigins.includes(url.origin)) ||
    (authority.privateNetwork === 'deny' && isPrivateNetworkHost(url.hostname))
  ) throw createWebNetworkError('network.invalid_url')
  return url
}

export const authorizeResolvedAddress = (
  authority: ResolvedNetworkAuthority,
  address: string
) => {
  const parsed = typeof address === 'string' ? parseAddress(address) : undefined
  if (parsed == null || (authority.privateNetwork === 'deny' && !parsed.public)) {
    throw createWebNetworkError('network.invalid_url')
  }
  return parsed.normalized
}
