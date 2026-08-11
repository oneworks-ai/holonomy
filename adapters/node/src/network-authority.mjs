import { isIP } from 'node:net'

const privateIpv4 = address => {
  const [a, b] = address.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 2, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0) || a >= 224
}

const ipv6Words = address => {
  let normalized = address.toLowerCase()
  if (normalized.includes('%')) return []
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':')
    const bytes = normalized.slice(lastColon + 1).split('.').map(Number)
    if (bytes.length !== 4 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return []
    normalized = `${normalized.slice(0, lastColon)}:${((bytes[0] << 8) | bytes[1]).toString(16)}:${
      ((bytes[2] << 8) | bytes[3]).toString(16)
    }`
  }
  const sides = normalized.split('::')
  if (sides.length > 2) return []
  const head = sides[0] === '' ? [] : sides[0].split(':')
  const tail = sides.length === 1 || sides[1] === '' ? [] : sides[1].split(':')
  const missing = 8 - head.length - tail.length
  if (missing < 0 || (sides.length === 1 && missing !== 0)) return []
  const words = [...head, ...Array.from({ length: missing }, () => '0'), ...tail].map(word => Number.parseInt(word, 16))
  return words.length === 8 && words.every(word => Number.isInteger(word) && word >= 0 && word <= 0xFFFF) ? words : []
}

const embeddedIpv4 = (high, low) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`

const privateIpv6 = address => {
  const words = ipv6Words(address)
  if (words.length !== 8) return true
  const [first, second] = words
  if (words.slice(0, 6).every(word => word === 0)) {
    if (words[6] === 0 && words[7] <= 1) return true
    return privateIpv4(embeddedIpv4(words[6], words[7]))
  }
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xFFFF) {
    return privateIpv4(embeddedIpv4(words[6], words[7]))
  }
  return (first & 0xFE00) === 0xFC00 || (first & 0xFFC0) === 0xFE80 || (first & 0xFFC0) === 0xFEC0 ||
    (first & 0xFF00) === 0xFF00 || first === 0x100 || first === 0x2002 ||
    (first === 0x2001 && [0x10, 0x20, 0xDB8].includes(second)) || (first === 0x64 && second === 0xFF9B)
}

export const isPrivateAddress = address => {
  const family = isIP(address)
  return family === 4 ? privateIpv4(address) : family === 6 ? privateIpv6(address) : true
}

export class NodeNetworkAuthority {
  #rules

  constructor(rules = []) {
    if (!Array.isArray(rules)) throw new TypeError('Node network authority rules must be an array')
    this.#rules = Object.freeze(rules.map(rule => {
      if (rule == null || typeof rule !== 'object' || typeof rule.origin !== 'string') {
        throw new TypeError('Invalid Node network authority rule')
      }
      if (Object.keys(rule).some(key => !['allowPrivateNetwork', 'methods', 'origin'].includes(key))) {
        throw new TypeError('Invalid Node network authority rule')
      }
      let origin = '*'
      if (rule.origin !== '*') {
        try {
          origin = new URL(rule.origin).origin
        } catch {
          throw new TypeError('Invalid Node network authority rule')
        }
        if (origin !== rule.origin || !/^https?:/u.test(origin)) {
          throw new TypeError('Invalid Node network authority rule')
        }
      }
      if (rule.methods != null && !Array.isArray(rule.methods)) {
        throw new TypeError('Invalid Node network authority rule')
      }
      const methods = rule.methods == null ? undefined : new Set(rule.methods)
      if (
        methods != null && [...methods].some(method => typeof method !== 'string' || method !== method.toUpperCase())
      ) {
        throw new TypeError('Invalid Node network authority rule')
      }
      return Object.freeze({ allowPrivateNetwork: rule.allowPrivateNetwork === true, methods, origin })
    }))
  }

  authorizeRequest({ method, url }) {
    const rule = this.#rules.find(candidate =>
      (candidate.origin === '*' || candidate.origin === url.origin) &&
      (candidate.methods == null || candidate.methods.has(method))
    )
    if (rule == null) throw Object.assign(new Error('Node network request denied'), { code: 'permission_denied' })
    return Object.freeze({ allowPrivateNetwork: rule.allowPrivateNetwork })
  }

  authorizeAddress({ address, decision }) {
    if (!decision.allowPrivateNetwork && isPrivateAddress(address)) {
      throw Object.assign(new Error('Node network address denied'), { code: 'permission_denied' })
    }
  }
}
