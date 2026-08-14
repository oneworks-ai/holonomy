import { invalidPolicy } from './errors.js'

const canonicalAddress = (value: string): { address: string; family: 'IPv4' | 'IPv6' } => {
  try {
    if (value.includes(':')) {
      if (value.includes('%')) return invalidPolicy()
      const host = new URL(`http://[${value}]/`).hostname
      const address = host.slice(1, -1)
      if (address !== value.toLowerCase()) return invalidPolicy()
      return { address, family: 'IPv6' }
    }
    const address = new URL(`http://${value}/`).hostname
    if (address !== value) return invalidPolicy()
    return { address, family: 'IPv4' }
  } catch {
    return invalidPolicy()
  }
}

export const normalizeIpAddress = (value: unknown, expected?: 'IPv4' | 'IPv6'): string => {
  if (typeof value !== 'string' || value.length > 64) return invalidPolicy()
  const normalized = canonicalAddress(value)
  if (expected !== undefined && normalized.family !== expected) return invalidPolicy()
  return normalized.address
}

export const normalizeCidr = (value: unknown, expected?: 'IPv4' | 'IPv6'): string | null => {
  if (value === null) return null
  if (typeof value !== 'string') return invalidPolicy()
  const slash = value.lastIndexOf('/')
  if (slash <= 0 || slash === value.length - 1) return invalidPolicy()
  const address = canonicalAddress(value.slice(0, slash))
  if (expected !== undefined && address.family !== expected) return invalidPolicy()
  const prefixText = value.slice(slash + 1)
  if (!/^(?:0|[1-9]\d{0,2})$/u.test(prefixText)) return invalidPolicy()
  const prefix = Number(prefixText)
  if (prefix > (address.family === 'IPv4' ? 32 : 128)) return invalidPolicy()
  return `${address.address}/${prefix}`
}
