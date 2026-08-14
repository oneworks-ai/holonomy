import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { NodeV86FilesystemBrokerV1 } from '../src/capability-process-v86-filesystem-broker.mjs'

const binary = value => ({
  base64: Buffer.from(value).toString('base64'),
  byteLength: Buffer.byteLength(value),
  sha256: createHash('sha256').update(value).digest('hex')
})

const input = values => ({
  environmentId: '3:runtime',
  executableId: 'selftest',
  generation: 3,
  linuxPid: 44,
  path: '/workspace/input file.txt',
  policy: {
    access: 'sandboxed',
    mounts: [{ guestPath: '/workspace', rights: ['read', 'write'], rootId: 'workspace' }]
  },
  processId: 9,
  processResourceId: 'process-9',
  requestId: 12,
  scope: 'runtime',
  signal: new AbortController().signal,
  ...values
})

test('routes attributed v86 FUSE operations through trusted Broker invocations', async () => {
  const calls = []
  const bridge = new NodeV86FilesystemBrokerV1().bind(async request => {
    calls.push(request)
    if (request.member === 'stat') {
      return { birthtimeMs: 0, ctimeMs: 0, kind: 'file', mtimeMs: 0, size: 5 }
    }
    if (request.member === 'open') {
      return { binding: { bindingId: 'fd-10', generation: 3 }, resourceType: 'filesystem.file-handle' }
    }
    if (request.member === 'FileHandle.readFile') return binary('ell')
    return {}
  })

  assert.deepEqual(await bridge.dispatch(input({ operation: 'lookup' })), {
    birthtimeMs: 0,
    ctimeMs: 0,
    kind: 'file',
    mtimeMs: 0,
    size: 5
  })
  const handle = await bridge.dispatch(input({ flags: 0, operation: 'open' }))
  assert.equal(handle, 'fd-10')
  assert.equal(
    Buffer.from(
      await bridge.dispatch(input({
        handle,
        offset: 1,
        operation: 'read',
        size: 3
      }))
    ).toString(),
    'ell'
  )
  await bridge.dispatch(input({ handle, operation: 'release' }))

  assert.equal(calls[0].path, 'holo-fs://workspace/input%20file.txt')
  assert.deepEqual(calls[0].source, {
    environmentId: '3:runtime',
    environmentScope: 'runtime',
    executableId: 'selftest',
    kind: 'linuxProcess',
    linuxPid: 44,
    processResourceId: 'process-9',
    syntheticProcessId: 9
  })
  assert.deepEqual(calls.map(call => call.member), [
    'stat',
    'open',
    'FileHandle.readFile',
    'FileHandle.close'
  ])
  assert.deepEqual(calls[2].providerData, { kind: 'positionedRead', offset: 1, size: 3 })
})

test('rejects Linux paths outside Host-declared mounts', async () => {
  const bridge = new NodeV86FilesystemBrokerV1().bind(async () => {
    throw new Error('unreachable')
  })
  await assert.rejects(
    bridge.dispatch(input({ operation: 'lookup', path: '/etc/passwd' })),
    error => error.errno === 13
  )
})

test('enforces mount rights and canonical Linux paths before invoking the Runtime Kernel', async () => {
  let calls = 0
  const bridge = new NodeV86FilesystemBrokerV1().bind(async () => {
    calls += 1
    throw new Error('unreachable')
  })
  const readOnly = input({
    flags: 0x41,
    operation: 'create',
    policy: {
      access: 'sandboxed',
      mounts: [{ guestPath: '/workspace', rights: ['read'], rootId: 'workspace' }]
    }
  })
  await assert.rejects(bridge.dispatch(readOnly), error => error.errno === 13)
  await assert.rejects(
    bridge.dispatch(input({ operation: 'lookup', path: '/workspace/../secret' })),
    error => error.errno === 13
  )
  assert.equal(calls, 0)
})
