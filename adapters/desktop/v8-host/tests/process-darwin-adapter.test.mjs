import assert from 'node:assert/strict'
import { it as test } from 'vitest'

import { encodeBase64 } from '../../../../packages/runtime/src/node-compat/encoding.ts'

import {
  NATIVE_DARWIN_PROCESS_DESCRIPTOR_V1,
  normalizeNativeDarwinConfigurationV1,
  normalizeNativeDarwinExecutableV1
} from '../bootstrap/process-darwin-backend.mjs'
import { MAX_DARWIN_STDIN_CHUNK_BYTES_V1, NativeDarwinProcessCommandV1 } from '../bootstrap/process-darwin-command.mjs'
import { NativeDarwinProcessHostPortV1 } from '../bootstrap/process-darwin-host-port.mjs'
import { createPrivateNativeDarwinProcessProviderV1 } from '../bootstrap/process-darwin-installation.mjs'
import { NativeProcessBackendRegistryV1 } from '../bootstrap/process-v86-backend.mjs'

const configuration = Object.freeze({ runtimeReadPaths: [], sandboxExecutablePath: '/usr/bin/sandbox-exec' })
const profile = Object.freeze({
  backend: { backendId: 'native.darwin-seatbelt-v1', configuration },
  environment: { allowedScopes: ['processTree'], defaultScope: 'processTree', capabilityBridge: { domains: [] } },
  executables: [{
    executableId: 'echo',
    executable: { kind: 'hostPath', path: '/bin/echo' },
    fixedArgs: ['fixed'],
    shell: false
  }],
  profile: 'process-profile-v1'
})
const policy = Object.freeze({
  access: 'sandboxed',
  executables: [{ executableId: 'echo', argumentBytes: 1024 }],
  environment: { allowedNames: [], maxValueBytes: 1024 },
  limits: { maxWritableRootfsBytes: 0, maxStdoutBytes: 4096, maxStderrBytes: 4096 },
  mounts: [],
  network: { access: 'none' }
})
const installation = Object.freeze({
  backendId: 'native.darwin-seatbelt-v1',
  implementation: 'builtin.darwin-seatbelt-v1'
})
const ok = value => JSON.stringify({ schemaVersion: 1, ok: true, value })
const error = code => JSON.stringify({ schemaVersion: 1, ok: false, code })

class MockDarwinProcess {
  calls = []
  events = []
  writeCount = 0
  backpressureAt = 0
  failWriteAt = 0

  push(kind, fields = {}) {
    this.events.push({
      handle: 'job-1',
      processResourceId: 'process-1',
      kind,
      ...fields
    })
  }

  call = encoded => {
    const input = JSON.parse(encoded)
    this.calls.push(input)
    switch (input.kind) {
      case 'install':
        return ok({ installed: true })
      case 'spawn':
        return ok({ handle: 'job-1' })
      case 'spawnSync':
        return ok({
          status: 0,
          signal: null,
          stdoutBase64: encodeBase64(Uint8Array.of(120), false),
          stderrBase64: ''
        })
      case 'poll':
        return ok({ events: this.events.splice(0, input.maxEvents), remaining: this.events.length })
      case 'write':
        this.writeCount += 1
        return this.writeCount === this.failWriteAt
          ? error('limit')
          : ok({ accepted: this.writeCount !== this.backpressureAt })
      case 'close':
      case 'end':
      case 'destroy':
      case 'signal':
        return ok({})
      default:
        return error('invalid')
    }
  }
}

const install = mock =>
  createPrivateNativeDarwinProcessProviderV1({
    generation: 1,
    installation,
    nativeDarwinProcess: mock.call,
    policy,
    processProfile: profile
  })

test('darwin profile selection admits only bounded Host paths and static processTree Policy', async () => {
  assert.throws(() => normalizeNativeDarwinConfigurationV1({ ...configuration, runtimeReadPaths: ['/Users'] }))
  assert.throws(() => normalizeNativeDarwinExecutableV1({ kind: 'hostPath', path: '/bin/../tmp/echo' }))
  const mock = new MockDarwinProcess()
  assert.throws(() =>
    createPrivateNativeDarwinProcessProviderV1({
      generation: 1,
      installation,
      nativeDarwinProcess: mock.call,
      policy: { ...policy, access: 'none' },
      processProfile: profile
    })
  )
  assert.throws(() =>
    createPrivateNativeDarwinProcessProviderV1({
      generation: 1,
      installation,
      nativeDarwinProcess: mock.call,
      policy: { ...policy, network: { access: 'sandboxed' } },
      processProfile: profile
    })
  )
  assert.throws(() =>
    createPrivateNativeDarwinProcessProviderV1({
      generation: 1,
      installation,
      nativeDarwinProcess: mock.call,
      policy,
      processProfile: {
        ...profile,
        executables: [{
          ...profile.executables[0],
          executable: {
            kind: 'hostPath',
            path: '/tmp/echo'
          }
        }]
      }
    })
  )
  assert.equal(mock.calls.length, 0)
  const selected = install(mock)
  assert.equal(selected.provider.module, 'host.process')
  assert.equal(selected.descriptor.backendId, 'native.darwin-seatbelt-v1')
  assert.equal(mock.calls[0].kind, 'install')
  assert.equal(mock.calls[0].profile.executables[0].executable.path, '/bin/echo')
  await selected.close()
  assert.equal(mock.calls.at(-1).kind, 'close')
  const builtin = new MockDarwinProcess()
  const withoutManifest = createPrivateNativeDarwinProcessProviderV1({
    generation: 1,
    nativeDarwinProcess: builtin.call,
    policy,
    processProfile: profile
  })
  assert.equal(withoutManifest.descriptor.backendId, 'native.darwin-seatbelt-v1')
  await withoutManifest.close()
})

test('backend registry permits synchronous Spawn only when a concrete implementation exists', () => {
  const required = {
    descriptor: NATIVE_DARWIN_PROCESS_DESCRIPTOR_V1,
    closeGeneration() {},
    normalizeConfiguration() {},
    normalizeExecutable() {},
    prepareLaunch() {},
    spawn() {},
    validateProfile() {},
    poll() {}
  }
  assert.throws(() => new NativeProcessBackendRegistryV1([required]))
  assert.equal(
    new NativeProcessBackendRegistryV1([{ ...required, spawnSync() {} }])
      .get('native.darwin-seatbelt-v1').descriptor.features.synchronousSpawn,
    true
  )
})

test('private event and stdin commands map to the shared Process Host sink without native identity', async () => {
  const mock = new MockDarwinProcess()
  const selected = install(mock)
  const port = new NativeDarwinProcessHostPortV1(selected.registry.get('native.darwin-seatbelt-v1'))
  const launch = port.prepareLaunch({
    configuration: selected.profile.backend.configuration,
    executables: selected.profile.executables,
    environmentScope: 'processTree',
    executable: selected.profile.executables[0].executable,
    executableId: 'echo',
    generation: 1,
    operation: 'process.program.spawn',
    policy,
    runtimeArgs: ['fixed', 'hello']
  })
  const events = []
  const names = [
    'spawn',
    'error',
    'exit',
    'close',
    'stdout',
    'stdoutEnd',
    'stdoutError',
    'stdoutClose',
    'stderr',
    'stderrEnd',
    'stderrError',
    'stderrClose',
    'stdinError',
    'stdinClose',
    'stdinCallback'
  ]
  const sink = Object.freeze(Object.fromEntries(names.map(name => [name, (...args) => events.push([name, ...args])])))
  const handle = port.spawn(launch, {
    env: {},
    generation: 1,
    limits: policy.limits,
    processResourceId: 'process-1',
    stdio: ['pipe', 'pipe', 'pipe']
  }, sink)
  assert.equal(mock.calls.at(-1).executableId, 'echo')
  assert.equal(mock.calls.at(-1).args.join(' '), 'fixed hello')
  assert.equal(mock.calls.at(-1).processResourceId, 'process-1')
  assert.equal(Object.hasOwn(mock.calls.at(-1), 'path'), false)
  assert.equal(handle.writeStdin(Uint8Array.of(65), undefined), true)
  handle.endStdin(7)
  handle.destroyStdio(2)
  handle.signal('SIGTERM')
  assert.equal(mock.calls.find(call => call.kind === 'write').callbackId, null)
  mock.push('spawn')
  mock.push('stdout', { base64: 'eA==' })
  mock.push('stdinCallback', { callbackId: null, code: null })
  mock.push('stdinCallback', { callbackId: 7, code: null })
  mock.push('stdinCallback', { callbackId: 8, code: 'EPIPE' })
  mock.push('stdoutEnd')
  mock.push('exit', { status: 0, signal: null })
  mock.push('stdoutClose')
  mock.push('stderrClose')
  mock.push('stdinClose')
  mock.push('close', { status: 0, signal: null })
  port.poll()
  assert.deepEqual(events.map(item => item[0]), [
    'spawn',
    'stdout',
    'stdinCallback',
    'stdinCallback',
    'stdinCallback',
    'stdoutEnd',
    'exit',
    'stdoutClose',
    'stderrClose',
    'stdinClose',
    'close'
  ])
  assert.deepEqual([...events[1][1]], [120])
  assert.deepEqual(events[2], ['stdinCallback', undefined, null])
  assert.deepEqual(events[4], ['stdinCallback', 8, 'EPIPE'])
  assert.deepEqual(events.at(-1), ['close', 0, null])
  mock.push('close', { status: 0, signal: null })
  port.poll()
  assert.equal(events.filter(item => item[0] === 'close').length, 1)
  await selected.close()
})

test('one public stdin write uses bounded FIFO chunks and one terminal callback', async () => {
  const mock = new MockDarwinProcess()
  mock.backpressureAt = 2
  const selected = install(mock)
  const port = new NativeDarwinProcessHostPortV1(selected.registry.get('native.darwin-seatbelt-v1'))
  const handle = port.spawn({ executableId: 'echo', args: [], limits: policy.limits }, {
    env: {},
    generation: 1,
    limits: policy.limits,
    processResourceId: 'process-1',
    stdio: ['pipe', 'pipe', 'pipe']
  }, {})
  const bytes = new Uint8Array(MAX_DARWIN_STDIN_CHUNK_BYTES_V1 * 2 + 1)
  const descriptor = port.describeOutput(bytes)
  const decoded = port.decodeInput(descriptor)
  assert.equal(decoded.byteLength, bytes.byteLength)
  assert.throws(() => port.decodeInput({ ...descriptor, sha256: '0'.repeat(64) }))
  assert.equal(handle.writeStdin(decoded, 9), false)
  const writes = mock.calls.filter(call => call.kind === 'write')
  assert.equal(writes.length, 3)
  assert.deepEqual(writes.map(call => call.callbackId), [null, null, 9])
  assert.ok(writes.every(call => call.base64.length <= Math.ceil(MAX_DARWIN_STDIN_CHUNK_BYTES_V1 / 3) * 4))
  mock.failWriteAt = mock.writeCount + 2
  assert.throws(() => handle.writeStdin(new Uint8Array(MAX_DARWIN_STDIN_CHUNK_BYTES_V1 + 1), 10), {
    code: 'darwin.limit'
  })
  assert.equal(mock.calls.at(-1).kind, 'signal')
  assert.equal(mock.calls.at(-1).signal, 'SIGKILL')
  await selected.close()
})

test('sync results decode bounded bytes and reject native PID/path or malformed late events', async () => {
  const mock = new MockDarwinProcess()
  const selected = install(mock)
  const port = new NativeDarwinProcessHostPortV1(selected.registry.get('native.darwin-seatbelt-v1'))
  const launch = port.prepareLaunch({
    configuration: selected.profile.backend.configuration,
    executables: selected.profile.executables,
    environmentScope: 'processTree',
    executable: selected.profile.executables[0].executable,
    executableId: 'echo',
    generation: 1,
    operation: 'process.program.spawnSync',
    policy,
    runtimeArgs: ['fixed']
  })
  const result = port.spawnSync(launch, {
    env: {},
    encoding: 'buffer',
    killSignal: 'SIGKILL',
    maxBuffer: 4096,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 1000
  })
  assert.equal(result.status, 0)
  assert.deepEqual([...result.stdout], [120])
  assert.equal(mock.calls.at(-1).processResourceId, 'sync-1-1')
  const bad = new NativeDarwinProcessCommandV1(() =>
    ok({
      status: 0,
      signal: null,
      stdoutBase64: '',
      stderrBase64: '',
      pid: 42
    })
  )
  assert.throws(() => bad.spawnSync({ maxBuffer: 1, encoding: 'buffer' }))
  const thrown = new NativeDarwinProcessCommandV1(() => {
    throw new Error('private /Users/someone/secret')
  })
  assert.throws(() => thrown.command('poll', { generation: 1, maxEvents: 1 }), {
    code: 'darwin.io',
    message: 'Native Darwin Process operation failed'
  })
  mock.push('spawn', { generation: 2 })
  port.poll()
  assert.equal(mock.events.length, 0)
  mock.push('spawn', { nativePid: 123 })
  assert.throws(() => port.poll())
  await selected.close()
})
