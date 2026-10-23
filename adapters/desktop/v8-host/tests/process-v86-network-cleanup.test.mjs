import assert from 'node:assert/strict'

import { it as test } from 'vitest'

import { NativeV86ProcessNetworkPortV1 } from '../bootstrap/process-v86-network-port.mjs'

const failure = code => Object.assign(new Error(code), { code })
const policy = Object.freeze({
  access: 'sandboxed',
  network: {
    access: 'restricted',
    privateNetwork: 'deny',
    endpoints: [{ hostname: 'example.test', ports: [9000], transport: 'tcp' }]
  }
})
const endpoint = Object.freeze({
  hostname: 'example.test',
  port: 9000,
  transport: 'tcp',
  semanticResourceDigest: 'a'.repeat(64)
})
const source = Object.freeze({
  kind: 'linuxProcess',
  environmentId: 'vm-1',
  executableId: 'echo',
  linuxPid: 29,
  processId: 23,
  processResourceId: 'process-1'
})
const makeRequest = signal => ({ environmentId: 'vm-1', policy, scope: 'processTree', signal })
const context = signal => ({
  source: { ...source, syntheticProcessId: source.processId },
  resource: { requested: endpoint },
  signal
})

test('id-zero Native rejection is consumed and an unspent open token is discarded', async () => {
  const sync = []
  const native = {
    processNetworkSync(encoded) {
      sync.push(JSON.parse(encoded))
      return JSON.stringify({ ok: true, value: {} })
    },
    processNetworkStart() {
      return { id: 0, promise: Promise.reject(failure('provider.unavailable')) }
    },
    processNetworkCancel() {}
  }
  const port = new NativeV86ProcessNetworkPortV1(native, 1, policy, () => 100)
  await assert.rejects(port.task('openTcp', { resolutionToken: 'dns-0' }), { code: 'provider.unavailable' })
  assert.deepEqual(sync.map(command => command.kind), ['installProfile', 'discardResolution'])
})

test('late completed DNS and socket jobs clean returned handles after abort', async () => {
  const sync = []
  const pending = []
  const cancelled = []
  const native = {
    processNetworkSync(encoded) {
      sync.push(JSON.parse(encoded))
      return JSON.stringify({ ok: true, value: {} })
    },
    processNetworkStart(encoded) {
      const input = JSON.parse(encoded)
      return {
        id: pending.length + 1,
        promise: new Promise(resolve => pending.push({ input, resolve }))
      }
    },
    processNetworkCancel(id) {
      cancelled.push(id)
    }
  }
  const port = new NativeV86ProcessNetworkPortV1(native, 1, policy, () => 100)
  const dnsAbort = new AbortController()
  const dns = port.task('resolve', { hostname: 'example.test' }, dnsAbort.signal)
  dnsAbort.abort()
  pending[0].resolve(JSON.stringify({ resolutionToken: 'dns-late' }))
  await assert.rejects(dns, { code: 'runtime.cancelled' })
  const openAbort = new AbortController()
  const open = port.task('openTcp', { resolutionToken: 'dns-open' }, openAbort.signal)
  openAbort.abort()
  pending[1].resolve(JSON.stringify({ socketToken: 'socket-late' }))
  await assert.rejects(open, { code: 'runtime.cancelled' })
  const before = new AbortController()
  before.abort()
  await assert.rejects(port.task('openTcp', { resolutionToken: 'dns-before' }, before.signal), {
    code: 'runtime.cancelled'
  })
  assert.deepEqual(cancelled, [1, 2])
  assert.equal(pending.length, 2)
  assert.deepEqual(
    sync.filter(command => command.kind === 'discardResolution').map(command => command.resolutionToken),
    [
      'dns-late',
      'dns-open',
      'dns-before'
    ]
  )
  assert.deepEqual(sync.filter(command => command.kind === 'close').map(command => command.socketToken), [
    'socket-late'
  ])
})

for (const phase of ['initial', 'verify']) {
  test(`${phase} DNS checks every address and discards a private IPv6 token`, async () => {
    const sync = []
    const native = {
      processNetworkSync(encoded) {
        sync.push(JSON.parse(encoded))
        return JSON.stringify({ ok: true, value: {} })
      },
      processNetworkStart(encoded) {
        const input = JSON.parse(encoded)
        const addresses = phase === 'initial' && input.kind === 'resolve' ||
            phase === 'verify' && input.kind === 'verifyResolution'
          ? ['8.8.8.8', 'fc00::1']
          : ['8.8.8.8']
        return {
          id: 1,
          promise: Promise.resolve(JSON.stringify({
            resolutionToken: 'dns-private',
            addresses,
            expiresAtMonotonicMs: 1000,
            resolverGeneration: 1
          }))
        }
      },
      processNetworkCancel() {}
    }
    const port = new NativeV86ProcessNetworkPortV1(native, 1, policy, () => 100)
    const signal = new AbortController().signal
    port.bind(async () => {
      const resolution = await port.resolveNetwork({ context: context(signal), generation: 1, policy })
      await resolution.verify()
      throw new Error('unexpected authorization')
    })
    await assert.rejects(port.authorize(source, makeRequest(signal), endpoint), { code: 'policy.denied' })
    assert.equal(sync.filter(command => command.kind === 'discardResolution').length, 1)
    assert.equal(sync.some(command => command.kind === 'bindResolution'), false)
    assert.equal(sync.some(command => command.kind === 'openTcp'), false)
  })
}

test('vm abort before DNS completion prevents late binding', async () => {
  const sync = []
  let release
  const native = {
    processNetworkSync(encoded) {
      sync.push(JSON.parse(encoded))
      return JSON.stringify({ ok: true, value: {} })
    },
    processNetworkStart() {
      return {
        id: 1,
        promise: new Promise(resolve => {
          release = resolve
        })
      }
    },
    processNetworkCancel() {}
  }
  const port = new NativeV86ProcessNetworkPortV1(native, 1, policy, () => 100)
  const controller = new AbortController()
  port.bind(() => port.resolveNetwork({ context: context(controller.signal), generation: 1, policy }))
  const authorization = port.authorize(source, makeRequest(controller.signal), endpoint)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof release, 'function')
  controller.abort()
  release(JSON.stringify({
    resolutionToken: 'dns-after-abort',
    addresses: ['8.8.8.8'],
    expiresAtMonotonicMs: 1000,
    resolverGeneration: 1
  }))
  await assert.rejects(authorization, { code: 'runtime.cancelled' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(
    sync.filter(command => command.kind === 'discardResolution').map(command => command.resolutionToken),
    [
      'dns-after-abort'
    ]
  )
  assert.equal(sync.some(command => command.kind === 'bindResolution'), false)
})

test('an IPv6-only Host DNS target remains selectable behind the VM IPv4 relay', async () => {
  const native = {
    processNetworkSync() {
      return JSON.stringify({ ok: true, value: {} })
    },
    processNetworkStart() {
      return {
        id: 1,
        promise: Promise.resolve(JSON.stringify({
          resolutionToken: 'dns-v6',
          addresses: ['2001:4860:4860::8888'],
          expiresAtMonotonicMs: 1000,
          resolverGeneration: 1
        }))
      }
    },
    processNetworkCancel() {}
  }
  const port = new NativeV86ProcessNetworkPortV1(native, 1, policy, () => 100)
  const signal = new AbortController().signal
  port.bind(async () => {
    const resolution = await port.resolveNetwork({ context: context(signal), generation: 1, policy })
    await resolution.verify()
    const digest = 'b'.repeat(64)
    resolution.bindResolvedContext({ resource: { binding: { invocationBindingDigest: digest } } })
    return {
      authorized: true,
      generation: 1,
      invocationBindingDigest: digest,
      semanticResourceDigest: endpoint.semanticResourceDigest,
      resolution: resolution.receipt
    }
  })
  const result = await port.authorize(source, makeRequest(signal), endpoint)
  assert.equal(result.address, '2001:4860:4860::8888')
})
