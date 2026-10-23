import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { decodeHoloUvCapabilityResponseV1, encodeHoloUvCapabilityRequestV1 } from '@holonomyjs/holouv'

import { NodeV86CapabilityBrokerV1 } from '../src/capability-process-v86-capability-broker.mjs'

const input = (command, overrides = {}) => ({
  environmentId: '1:processTree:process-1',
  executableId: 'hoholo',
  generation: 1,
  linuxPid: 201,
  parentLinuxPid: 200,
  payload: encodeHoloUvCapabilityRequestV1({ command, version: 1 }),
  processId: 47,
  processResourceId: 'process-1',
  processStartTimeTicks: 12345,
  rootLinuxPid: 200,
  scope: 'processTree',
  ...overrides
})
const read = async (broker, command, overrides) =>
  decodeHoloUvCapabilityResponseV1(await broker.handle(input(command, overrides)))
const system = ['system', 'read', 'os.arch']

test('Node alias uses the shared registry route and preserves actual Linux Process source', async () => {
  const calls = []
  const broker = new NodeV86CapabilityBrokerV1(['device', 'system']).bind(async (invocation, signal) => {
    calls.push({ invocation, signal })
    return invocation.module === 'node:os' ? 'x64' : { schemaVersion: 1 }
  })
  assert.deepEqual(await read(broker, system), { json: '"x64"', ok: true, version: 1 })
  assert.deepEqual(await read(broker, ['device', 'summary']), {
    json: '{"schemaVersion":1}',
    ok: true,
    version: 1
  })
  assert.deepEqual(calls[0].invocation, {
    arguments: {},
    member: 'arch',
    mode: 'sync',
    module: 'node:os',
    source: {
      environmentId: '1:processTree:process-1',
      environmentScope: 'processTree',
      executableId: 'hoholo',
      kind: 'linuxProcess',
      linuxPid: 201,
      parentLinuxPid: 200,
      processStartTimeTicks: 12345,
      processResourceId: 'process-1',
      rootLinuxPid: 200,
      syntheticProcessId: 47
    }
  })
  assert.equal(calls[1].invocation.member, 'getSummary')
  assert.equal(calls[1].invocation.module, 'holo:device/promises')
  assert.equal(calls[0].signal.aborted, false)
})

test('profile domains do not grant unknown, subscription or Kernel-denied operations', async () => {
  assert.deepEqual(await read(new NodeV86CapabilityBrokerV1(), system), {
    error: 'bridge.unavailable',
    ok: false,
    version: 1
  })
  let calls = 0
  const broker = new NodeV86CapabilityBrokerV1(['device', 'system']).bind(async () => {
    calls += 1
    throw Object.assign(new Error('denied'), { code: 'capability.denied' })
  })
  assert.deepEqual(await read(broker, ['device', 'read', 'device.no-such-field.read']), {
    error: 'bridge.unsupported',
    ok: false,
    version: 1
  })
  assert.deepEqual(await read(broker, ['device', 'read', 'device.events.subscribe']), {
    error: 'bridge.unsupported',
    ok: false,
    version: 1
  })
  assert.deepEqual(await read(broker, ['network', 'read', 'anything']), {
    error: 'bridge.unavailable',
    ok: false,
    version: 1
  })
  assert.equal(calls, 0)
  assert.deepEqual(await read(broker, system), {
    error: 'capability.denied',
    ok: false,
    version: 1
  })
  assert.equal(calls, 1)
})

test('bounded in-flight work retains its slot until the cancelled invocation settles', async () => {
  let settle
  let activeSignal
  let calls = 0
  const controller = new AbortController()
  const broker = new NodeV86CapabilityBrokerV1(['system'], { maxPending: 1, timeoutMs: 1000 })
    .bind((_invocation, signal) => {
      calls += 1
      if (calls > 1) return 'late-free'
      activeSignal = signal
      return new Promise(resolve => {
        settle = resolve
      })
    })
  const first = read(broker, system, { signal: controller.signal })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(await read(broker, system), { error: 'bridge.busy', ok: false, version: 1 })
  controller.abort()
  assert.deepEqual(await first, { error: 'bridge.cancelled', ok: false, version: 1 })
  assert.equal(activeSignal.aborted, true)
  assert.deepEqual(await read(broker, system), { error: 'bridge.busy', ok: false, version: 1 })
  settle('should-never-be-delivered')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await read(broker, system), { json: '"late-free"', ok: true, version: 1 })
})

test('timeout and generation close fence late responses', async () => {
  let settleTimeout
  const timeout = new NodeV86CapabilityBrokerV1(['system'], { timeoutMs: 10 })
    .bind(() =>
      new Promise(resolve => {
        settleTimeout = resolve
      })
    )
  const timed = read(timeout, system)
  assert.deepEqual(await timed, { error: 'bridge.timeout', ok: false, version: 1 })
  settleTimeout('late')
  assert.deepEqual(await read(new NodeV86CapabilityBrokerV1(['system']), system), {
    error: 'bridge.unavailable',
    ok: false,
    version: 1
  })

  let settleClosed
  const broker = new NodeV86CapabilityBrokerV1(['system'])
    .bind(() =>
      new Promise(resolve => {
        settleClosed = resolve
      })
    )
  const pending = read(broker, system)
  await Promise.resolve()
  await Promise.resolve()
  broker.closeGeneration(1)
  assert.deepEqual(await pending, { error: 'runtime.generation_stale', ok: false, version: 1 })
  settleClosed('late')
  assert.deepEqual(await read(broker, system), { error: 'runtime.generation_stale', ok: false, version: 1 })
})

test('failed Host timer admission releases an unstarted capability slot', async t => {
  let calls = 0
  const broker = new NodeV86CapabilityBrokerV1(['system'], { maxPending: 1 }).bind(() => {
    calls++
    return 'recovered'
  })
  const timer = t.mock.method(globalThis, 'setTimeout', () => {
    throw new Error('timer capacity')
  })
  try {
    assert.deepEqual(await read(broker, system), { error: 'bridge.failed', ok: false, version: 1 })
    assert.equal(calls, 0)
  } finally {
    timer.mock.restore()
  }
  assert.deepEqual(await read(broker, system), { json: '"recovered"', ok: true, version: 1 })
  assert.equal(calls, 1)
})
