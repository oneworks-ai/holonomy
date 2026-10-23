import assert from 'node:assert/strict'

import { it as test } from 'vitest'

import { NativeV86ProcessNetworkPortV1 } from '../bootstrap/process-v86-network-port.mjs'

test('process DNS token binds only the final invocation digest before socket open', async () => {
  const semantic = 'a'.repeat(64)
  const requested = 'b'.repeat(64)
  const final = 'c'.repeat(64)
  const policy = {
    access: 'sandboxed',
    network: {
      access: 'restricted',
      privateNetwork: 'allow',
      endpoints: [{ hostname: '127.0.0.1', port: 9000, ports: [9000], transport: 'tcp' }]
    }
  }
  const commands = []
  const native = {
    processNetworkSync(encoded) {
      commands.push(JSON.parse(encoded))
      return JSON.stringify({ ok: true, value: {} })
    },
    processNetworkStart(encoded) {
      const input = JSON.parse(encoded)
      commands.push(input)
      const value = input.kind === 'resolve' || input.kind === 'verifyResolution'
        ? { resolutionToken: 'dns-1', addresses: ['127.0.0.1'], expiresAtMonotonicMs: 1000, resolverGeneration: 1 }
        : { socketToken: 'socket-1' }
      return { id: commands.length, promise: Promise.resolve(JSON.stringify(value)) }
    },
    processNetworkCancel() {}
  }
  const port = new NativeV86ProcessNetworkPortV1(native, 1, policy, () => 100)
  const resource = { hostname: '127.0.0.1', port: 9000, transport: 'tcp', semanticResourceDigest: semantic }
  const source = {
    kind: 'linuxProcess',
    environmentId: 'vm-1',
    executableId: 'echo',
    linuxPid: 29,
    parentLinuxPid: 1,
    processId: 23,
    processResourceId: 'process-1',
    processStartTimeTicks: 1,
    rootLinuxPid: 29
  }
  const request = {
    environmentId: 'vm-1',
    policy,
    scope: 'processTree',
    signal: new AbortController().signal
  }
  let invocations = 0
  port.bind(async () => {
    if (++invocations > 1) throw new Error('no new receipt')
    const resolution = await port.resolveNetwork({
      context: {
        source: { ...source, syntheticProcessId: source.processId },
        resource: { binding: { invocationBindingDigest: requested }, requested: resource },
        signal: request.signal
      },
      generation: 1,
      policy
    })
    await resolution.verify()
    assert.equal(commands.some(input => input.kind === 'openTcp'), false)
    resolution.bindResolvedContext({ resource: { binding: { invocationBindingDigest: final } } })
    resolution.dispose()
    assert.equal(commands.find(input => input.kind === 'bindResolution').invocationBindingDigest, final)
    assert.equal(commands.some(input => input.kind === 'discardResolution'), false)
    return {
      authorized: true,
      generation: 1,
      invocationBindingDigest: final,
      semanticResourceDigest: semantic,
      resolution: resolution.receipt
    }
  })
  const authorized = await port.authorize(source, request, resource)
  assert.equal(authorized.address, '127.0.0.1')
  assert.equal(commands.some(input => input.kind === 'openTcp'), false)
  await assert.rejects(port.authorize(source, request, resource))
})

test('failed Kernel re-admission discards its newly bound DNS token', async () => {
  const calls = []
  const policy = {
    access: 'sandboxed',
    network: {
      access: 'restricted',
      privateNetwork: 'allow',
      endpoints: [{ hostname: '127.0.0.1', ports: [9000], transport: 'tcp' }]
    }
  }
  const native = {
    processNetworkSync(encoded) {
      calls.push(JSON.parse(encoded))
      return JSON.stringify({ ok: true, value: {} })
    },
    processNetworkStart(encoded) {
      const command = JSON.parse(encoded)
      calls.push(command)
      return {
        id: calls.length,
        promise: Promise.resolve(JSON.stringify({
          resolutionToken: 'dns-failed',
          addresses: ['127.0.0.1'],
          expiresAtMonotonicMs: 1000,
          resolverGeneration: 1
        }))
      }
    },
    processNetworkCancel() {}
  }
  const port = new NativeV86ProcessNetworkPortV1(native, 1, policy, () => 100)
  const source = {
    kind: 'linuxProcess',
    environmentId: 'vm-1',
    executableId: 'echo',
    linuxPid: 29,
    processId: 23,
    processResourceId: 'process-1'
  }
  const endpoint = { hostname: '127.0.0.1', port: 9000, transport: 'tcp', semanticResourceDigest: 'a'.repeat(64) }
  const request = {
    environmentId: 'vm-1',
    policy,
    scope: 'processTree',
    signal: new AbortController().signal
  }
  port.bind(async () => {
    const resolution = await port.resolveNetwork({
      context: {
        source: { ...source, syntheticProcessId: source.processId },
        resource: { requested: endpoint },
        signal: request.signal
      },
      generation: 1,
      policy
    })
    await resolution.verify()
    resolution.bindResolvedContext({ resource: { binding: { invocationBindingDigest: 'c'.repeat(64) } } })
    throw new Error('middleware.denied')
  })
  await assert.rejects(port.authorize(source, request, endpoint))
  assert.equal(calls.filter(command => command.kind === 'bindResolution').length, 1)
  assert.equal(calls.filter(command => command.kind === 'discardResolution').length, 1)
  assert.equal(calls.some(command => command.kind === 'openTcp'), false)
})

test('authorization waiters are bounded and an aborted waiter leaves the queue', async () => {
  let release
  const blocked = new Promise((_, reject) => {
    release = reject
  })
  const policy = {
    access: 'sandboxed',
    network: { access: 'restricted', endpoints: [{ hostname: '127.0.0.1', ports: [9000], transport: 'tcp' }] }
  }
  const native = {
    processNetworkSync() {
      return JSON.stringify({ ok: true, value: {} })
    },
    processNetworkStart() {
      throw new Error('unexpected network I/O')
    },
    processNetworkCancel() {}
  }
  const port = new NativeV86ProcessNetworkPortV1(native, 1, policy, () => 100)
  port.bind(() => blocked)
  const source = { executableId: 'echo', linuxPid: 29, processId: 23, processResourceId: 'process-1' }
  const endpoint = { hostname: '127.0.0.1', port: 9000, transport: 'tcp' }
  const controllers = Array.from({ length: 32 }, () => new AbortController())
  const requests = controllers.map(controller => ({
    environmentId: 'vm-1',
    policy,
    scope: 'processTree',
    signal: controller.signal
  }))
  const pending = requests.map(request => port.authorize(source, request, endpoint))
  const all = Promise.allSettled(pending)
  await assert.rejects(port.authorize(source, requests[0], endpoint), { code: 'provider.quota' })
  controllers[1].abort()
  await assert.rejects(pending[1], { code: 'runtime.cancelled' })
  release(new Error('Kernel denied'))
  const results = await all
  assert.equal(results.every(result => result.status === 'rejected'), true)
})
