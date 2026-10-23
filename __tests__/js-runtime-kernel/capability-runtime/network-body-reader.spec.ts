import { describe, expect, it } from 'vitest'

import {
  NetworkRequestBodyReaderRegistryV1,
  activateNetworkRequestBodyReaderV1
} from '../../../packages/capabilities/network/src/kernel/request-body-reader.js'
import { sha256Hex } from '../../../packages/runtime/src/module-loader/sha256.js'
import { encodeBase64 } from '../../../packages/runtime/src/node-compat/encoding.js'

const bytes = new TextEncoder().encode('private body')
const body = { kind: 'buffered' as const, length: bytes.length, sha256: sha256Hex(bytes) }
const base64 = encodeBase64(bytes, false)
const registry = (maxReads = 2) => new NetworkRequestBodyReaderRegistryV1({ generation: 1, maxReadBytes: 32, maxReads })

describe('network request body reader lifecycle', () => {
  it('caps concurrent staged bytes and leases before any middleware reads', () => {
    const owner = new NetworkRequestBodyReaderRegistryV1({ generation: 1, maxReadBytes: 1024 * 1024, maxReads: 1024 })
    const large = new Uint8Array(600 * 1024)
    const metadata = { kind: 'buffered' as const, length: large.length, sha256: sha256Hex(large) }
    const encoded = encodeBase64(large, false)
    const lease = owner.create(metadata, 'one', encoded)!
    expect(owner.create(metadata, 'two', encoded)).toBeUndefined()
    lease.close()
    expect(owner.create(metadata, 'two', encoded)).toBeDefined()
    owner.close()
    const countOwner = new NetworkRequestBodyReaderRegistryV1({ generation: 1, maxReadBytes: 1, maxReads: 1024 })
    const empty = { kind: 'buffered' as const, length: 0, sha256: sha256Hex(new Uint8Array()) }
    const leases = Array.from({ length: 64 }, (_, index) => countOwner.create(empty, String(index), '')!)
    expect(leases.every(Boolean)).toBe(true)
    expect(countOwner.create(empty, 'over', '')).toBeUndefined()
    leases[0]!.close()
    expect(countOwner.create(empty, 'after-close', '')).toBeDefined()
    countOwner.close()
  })

  it('requires Broker activation, copies once, and zeroes retained copies on cleanup', async () => {
    const owner = registry()
    const lease = owner.create(body, 'request-1', base64)!
    await expect(lease.binding.read({ maxBytes: 32 })).rejects.toThrow('unavailable')
    const close = activateNetworkRequestBodyReaderV1(
      lease.binding,
      'request-1',
      body.sha256,
      new AbortController().signal
    )
    const copy = await lease.binding.read({ maxBytes: 7 })
    expect(new TextDecoder().decode(copy)).toBe('private')
    await expect(lease.binding.read({ maxBytes: 32 })).rejects.toThrow('unavailable')
    close()
    expect([...copy]).toEqual(Array.from({ length: 7 }).fill(0))
    await expect(lease.binding.read({ maxBytes: 32 })).rejects.toThrow('unavailable')
    lease.close()
    owner.close()
  })

  it('checks complete staged digest and canonical bytes before publishing a reader', () => {
    const owner = registry()
    expect(() => owner.create({ ...body, sha256: '0'.repeat(64) }, 'request-1', base64)).toThrow(
      expect.objectContaining({ code: 'argument.invalid' })
    )
    expect(() => owner.create(body, 'request-1', `${base64}\n`)).toThrow()
    expect(owner.create({ ...body, length: 33 }, 'request-1', base64)).toBeUndefined()
    expect(owner.create(body, 'request-1', undefined)).toBeUndefined()
    owner.close()
  })

  it('enforces the Runtime read budget and rejects forged or rebound bindings', async () => {
    const owner = registry(1)
    const lease = owner.create(body, 'request-1', base64)!
    const signal = new AbortController().signal
    expect(() => activateNetworkRequestBodyReaderV1(lease.binding, 'another-request', body.sha256, signal)).toThrow()
    expect(() => activateNetworkRequestBodyReaderV1({ ...lease.binding }, 'request-1', body.sha256, signal)).toThrow()
    activateNetworkRequestBodyReaderV1(lease.binding, 'request-1', body.sha256, signal)
    expect(new TextDecoder().decode(await lease.binding.read())).toBe('private body')
    expect(owner.create(body, 'request-2', base64)).toBeUndefined()
    owner.close()
  })

  it('revokes on Abort and rejects maxBytes accessors without invoking them', async () => {
    const owner = registry()
    const lease = owner.create(body, 'request-1', base64)!
    const controller = new AbortController()
    activateNetworkRequestBodyReaderV1(lease.binding, 'request-1', body.sha256, controller.signal)
    let effects = 0
    await expect(lease.binding.read({
      get maxBytes() {
        effects++
        return 32
      }
    })).rejects.toThrow('unavailable')
    expect(effects).toBe(0)
    const copy = await lease.binding.read({ maxBytes: 32 })
    controller.abort()
    expect([...copy]).toEqual(Array.from({ length: bytes.length }).fill(0))
    await expect(lease.binding.read({ maxBytes: 32 })).rejects.toThrow('unavailable')
    owner.close()
  })
})
