import { Buffer } from 'node:buffer'
import vm from 'node:vm'

import { copyNodeCryptoBytes } from './node-crypto-binary.mjs'
import { NODE_CRYPTO_FACADE_SOURCE } from './node-crypto-facade-source.mjs'
import { createNodeCryptoProvider } from './node-crypto-provider.mjs'

const hex = bytes => {
  let encoded
  try {
    encoded = Buffer.from(bytes)
    return encoded.toString('hex')
  } finally {
    encoded?.fill(0)
    bytes.fill(0)
  }
}

// One provider and token table per Runtime generation. The returned control is
// Host-owned; the Guest receives only a separate Guest-local provider facade.
export function installNodeCryptoBridge(runtimeContext) {
  const provider = createNodeCryptoProvider()
  const contexts = new Map()
  let nextToken = 0
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    contexts.clear()
    provider.dispose()
  }
  const cryptoCall = (operation, token, first, second, third, fourth) => {
    let input
    let other
    try {
      if (operation === 'dispose') {
        dispose()
        return true
      }
      if (disposed) return operation === 'release' ? true : null
      if (operation === 'create') {
        if (contexts.size >= 64) return null
        const request = { algorithm: second, kind: first }
        if (first !== 'hash') request.key = input = copyNodeCryptoBytes(third, 65_536)
        if (first === 'cipher' || first === 'decipher') {
          request.iv = other = copyNodeCryptoBytes(fourth, 12)
        }
        const context = provider.createContext(request)
        const id = ++nextToken
        contexts.set(id, context)
        return id
      }
      if (operation === 'random') {
        if (!Number.isSafeInteger(first) || first < 0 || first > 65_536) return null
        return hex(provider.randomBytes(first))
      }
      if (operation === 'equal') {
        input = copyNodeCryptoBytes(first, 1024 * 1024)
        other = copyNodeCryptoBytes(second, 1024 * 1024)
        return provider.timingSafeEqual(input, other)
      }
      if (!Number.isSafeInteger(token) || !contexts.has(token)) return null
      const context = contexts.get(token)
      switch (operation) {
        case 'release':
          contexts.delete(token)
          provider.disposeContext(context)
          return true
        case 'digest':
          return hex(provider.digest(context))
        case 'final': {
          const result = provider.final(context)
          return JSON.stringify({
            authenticated: result.authenticated ?? null,
            authTag: result.authTag === undefined ? null : hex(result.authTag),
            output: hex(result.output)
          })
        }
        case 'update':
          input = copyNodeCryptoBytes(first, 1024 * 1024)
          return hex(provider.update(context, input))
        case 'aad':
          input = copyNodeCryptoBytes(first, 65_536)
          provider.setAAD(context, input)
          return true
        case 'tag':
          input = copyNodeCryptoBytes(first, 16)
          if (input.byteLength !== 16) return null
          provider.setAuthTag(context, input)
          return true
        default:
          return null
      }
    } catch {
      // No native exception, message, path or function leaves this call stack.
      return null
    } finally {
      input?.fill(0)
      other?.fill(0)
    }
  }
  const factory = vm.compileFunction(`return ${NODE_CRYPTO_FACADE_SOURCE}`, [], {
    contextExtensions: [Object.freeze({ cryptoCall })],
    filename: 'holonomy:///runtime/node-crypto-provider.mjs',
    parsingContext: runtimeContext.context
  })
  Object.defineProperty(runtimeContext.context, '__holonomyNodeCryptoProvider', {
    configurable: true,
    value: factory(),
    writable: false
  })
  return Object.freeze({ dispose })
}
