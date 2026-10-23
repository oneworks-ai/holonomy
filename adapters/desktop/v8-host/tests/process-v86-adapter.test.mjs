/* eslint-disable max-lines -- This adapter test exercises one framed v86 Host pipeline. */
import assert from 'node:assert/strict'
import { it as test } from 'vitest'

import { invokeProcessResourceV1 } from '../../../../packages/capabilities/process/src/host/resource-operations.mjs'
import {
  ProcessSupervisorFrameDecoderV1,
  encodeProcessSupervisorFrameV1,
  encodeProcessSupervisorReadyPayloadV1
} from '../../../../packages/capabilities/process/src/index.ts'
import {
  decodeHoloUvCapabilityResponseV1,
  encodeHoloUvCapabilityRequestV1,
  encodeHoloUvCompletionPayloadV1,
  encodeHoloUvSpawnedPayloadV1
} from '../../../../packages/holouv/src/index.ts'
import { CapabilityInvocationError } from '../../../../packages/runtime/src/kernel/errors.ts'
import { decodeBase64, encodeBase64 } from '../../../../packages/runtime/src/node-compat/encoding.ts'

import {
  NativeV86CommandPortV1,
  NativeV86ProcessHostPortV1,
  createPrivateNativeV86ProcessProviderV1,
  normalizeNativeV86ConfigurationV1,
  normalizeNativeV86ExecutableV1
} from '../bootstrap/process-v86-index.mjs'

const mib = 1024 * 1024
const installation = Object.freeze({
  root: '/private/holo-v86',
  bios: { sha256: 'a'.repeat(64) },
  kernel: { sha256: 'b'.repeat(64) },
  initrd: { sha256: 'c'.repeat(64) }
})
const configuration = Object.freeze({
  artifacts: {
    bios: { artifactId: 'seabios.bin', sha256: installation.bios.sha256 },
    kernel: { artifactId: 'kernel.bin', sha256: installation.kernel.sha256 },
    initrd: { artifactId: 'agent.cpio', sha256: installation.initrd.sha256 },
    wasm: { artifactId: 'v86.wasm', sha256: 'd'.repeat(64) }
  },
  memoryBytes: 64 * mib,
  requiredKernelCapabilities: ['process'],
  supervisor: { execGateTimeoutMs: 30_000, protocolVersion: 1 }
})
const profile = Object.freeze({
  backend: { backendId: 'experimental.v86-v1', configuration },
  environment: { allowedScopes: ['processTree'], defaultScope: 'processTree', capabilityBridge: { domains: [] } },
  executables: [{
    executableId: 'echo',
    executable: { kind: 'guestPath', path: '/bin/echo' },
    fixedArgs: [],
    shell: false
  }],
  profile: 'process-profile-v1'
})
const policy = Object.freeze({
  access: 'sandboxed',
  limits: { maxProcessTreeDepth: 1, maxTotalProcesses: 1 },
  mounts: [],
  network: { access: 'none' }
})
const frame = (operation, payload, processId = 0, requestId = 0, sequence = 0) =>
  encodeProcessSupervisorFrameV1({ operation, payload, processId, requestId, sequence, version: 1 })

class MockNativeV86 {
  capabilityCommand
  capabilityResponses = []
  commands = []
  records = new Map()

  constructor(capabilityCommand) {
    this.capabilityCommand = capabilityCommand
  }

  call = encoded => {
    const input = JSON.parse(encoded)
    this.commands.push(input)
    const ok = value => JSON.stringify({ schemaVersion: 1, ok: true, value })
    const error = code => JSON.stringify({ schemaVersion: 1, ok: false, code })
    if (input.schemaVersion !== 1) return error('invalid')
    if (input.kind === 'install') return ok({ installed: true, wasmSha256: input.wasmSha256 })
    if (input.kind === 'drainEvents') return ok({ events: [], remaining: 0 })
    if (input.kind === 'open') {
      this.records.set(input.id, {
        generation: input.generation,
        output: [],
        decoder: new ProcessSupervisorFrameDecoderV1()
      })
      return ok({ status: 'open' })
    }
    const record = this.records.get(input.id)
    if (record == null || record.generation !== input.generation) return error('generation')
    if (input.kind === 'start') {
      record.output.push(frame('ready', encodeProcessSupervisorReadyPayloadV1(['process'])))
      return ok({ status: 'running' })
    }
    if (input.kind === 'serialWrite') {
      assert.equal(input.uart, 1)
      const bytes = decodeBase64(input.base64)
      assert.ok(bytes.byteLength <= 64 * 1024)
      for (const message of record.decoder.push(bytes)) {
        if (message.operation === 'configure') {
          record.output.push(frame('ack', new Uint8Array(), 0, message.requestId))
        } else if (message.operation === 'spawn') {
          record.output.push(frame('spawned', encodeHoloUvSpawnedPayloadV1(29), 23, message.requestId))
          if (this.capabilityCommand == null) {
            record.output.push(frame('stdout', new TextEncoder().encode('linux-output'), 23, 0, 0))
            record.output.push(frame('exit', encodeHoloUvCompletionPayloadV1(4, null), 23))
            record.output.push(frame('close', encodeHoloUvCompletionPayloadV1(4, null), 23))
          } else {
            record.output.push(frame(
              'capabilityRequest',
              encodeHoloUvCapabilityRequestV1({ command: this.capabilityCommand, version: 1 }),
              23,
              31,
              29
            ))
          }
        } else if (message.operation === 'capabilityResponse') {
          this.capabilityResponses.push(decodeHoloUvCapabilityResponseV1(message.payload))
          record.output.push(frame('exit', encodeHoloUvCompletionPayloadV1(0, null), 23))
          record.output.push(frame('close', encodeHoloUvCompletionPayloadV1(0, null), 23))
        } else if (['stdin', 'stdinClose', 'signal'].includes(message.operation)) {
          record.output.push(frame('ack', new Uint8Array(), message.processId, message.requestId))
        }
      }
      return ok({})
    }
    if (input.kind === 'poll') {
      return ok({ status: 'running', queuedBytes: record.output.reduce((sum, item) => sum + item.length, 0) })
    }
    if (input.kind === 'drain') {
      const all = Uint8Array.from(record.output.flatMap(item => [...item]))
      const bytes = all.subarray(0, input.maxBytes)
      record.output = all.length === bytes.length ? [] : [all.subarray(bytes.length)]
      return ok({ uart: 1, base64: encodeBase64(bytes, false), remainingBytes: all.length - bytes.length })
    }
    if (input.kind === 'close') {
      this.records.delete(input.id)
      return ok({})
    }
    return error('invalid')
  }
}

const waitFor = async predicate => {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Mock v86 event pipeline did not settle')
}

test('private profile and Host installation reject paths, assets and unsupported bridges', () => {
  assert.throws(() => normalizeNativeV86ConfigurationV1({ ...configuration, memoryBytes: 32 * mib }))
  assert.throws(() => normalizeNativeV86ExecutableV1({ kind: 'guestPath', path: '/bin/../tmp/tool' }))
  const mock = new MockNativeV86()
  assert.throws(() =>
    createPrivateNativeV86ProcessProviderV1({
      installation: { ...installation, root: '/private/../guest' },
      nativeV86: mock.call,
      processProfile: profile,
      policy,
      generation: 1
    })
  )
  assert.throws(() =>
    createPrivateNativeV86ProcessProviderV1({
      installation,
      nativeV86: mock.call,
      processProfile: {
        ...profile,
        environment: { ...profile.environment, capabilityBridge: { domains: ['network'] } }
      },
      policy,
      generation: 1
    })
  )
  assert.throws(() =>
    createPrivateNativeV86ProcessProviderV1({
      installation,
      nativeV86: mock.call,
      processProfile: {
        ...profile,
        environment: { allowedScopes: ['runtime'], defaultScope: 'runtime', capabilityBridge: { domains: [] } }
      },
      policy,
      generation: 1
    })
  )
  assert.throws(() =>
    createPrivateNativeV86ProcessProviderV1({
      installation,
      nativeV86: mock.call,
      processProfile: {
        ...profile,
        backend: {
          ...profile.backend,
          configuration: {
            ...configuration,
            artifacts: { ...configuration.artifacts, kernel: { artifactId: 'kernel.bin', sha256: '0'.repeat(64) } }
          }
        }
      },
      policy,
      generation: 1
    })
  )
  assert.equal(mock.commands.length, 0)
})

test('wasm attestation must match before the shared Provider can be constructed', () => {
  const mock = new MockNativeV86()
  const call = encoded => {
    const result = JSON.parse(mock.call(encoded))
    if (JSON.parse(encoded).kind === 'install') result.value.wasmSha256 = '0'.repeat(64)
    return JSON.stringify(result)
  }
  assert.throws(() =>
    createPrivateNativeV86ProcessProviderV1({
      installation,
      nativeV86: call,
      processProfile: profile,
      policy,
      generation: 1
    })
  )
  assert.deepEqual(mock.commands.map(command => command.kind), ['install'])
})

test('native command binding enforces bounded serial and ordered event envelopes', () => {
  const mock = new MockNativeV86()
  const commands = new NativeV86CommandPortV1(mock.call)
  commands.install(installation)
  commands.open('vm-1', 1, 64 * mib)
  commands.start('vm-1', 1)
  assert.throws(() => commands.write('vm-1', 1, new Uint8Array(64 * 1024 + 1)))
  assert.equal(commands.poll('vm-1', 1).status, 'running')
  assert.ok(commands.drain('vm-1', 1).bytes.byteLength > 0)
  commands.close('vm-1', 1)
  assert.throws(() => commands.poll('vm-1', 1), { code: 'v86.generation' })
})

test('shared Provider uses HoloUV supervisor framing over private native serial1', async () => {
  const mock = new MockNativeV86()
  const installed = createPrivateNativeV86ProcessProviderV1({
    installation,
    nativeV86: mock.call,
    processProfile: profile,
    policy,
    generation: 1
  })
  assert.equal(installed.provider.module, 'host.process')
  assert.deepEqual(installed.registry.descriptors()[0].platforms, ['desktop'])
  installed.bindKernel({
    releaseResource() {},
    invokeFromSource: async () => ({
      authorized: true,
      generation: 1,
      invocationBindingDigest: 'a',
      semanticResourceDigest: 'b'
    })
  })
  const backend = installed.registry.get('experimental.v86-v1')
  const port = new NativeV86ProcessHostPortV1(backend)
  const events = []
  const sink = Object.fromEntries([
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
  ].map(name => [name, (...args) => events.push([name, ...args])]))
  const launch = port.prepareLaunch({
    configuration: installed.profile.backend.configuration,
    executables: installed.profile.executables,
    environmentScope: 'processTree',
    executable: installed.profile.executables[0].executable,
    executableId: 'echo',
    generation: 1,
    operation: 'process.program.spawn',
    policy,
    runtimeArgs: ['hello']
  })
  const handle = port.spawn(launch, {
    env: {},
    generation: 1,
    limits: {},
    processResourceId: 'process-1',
    stdio: ['pipe', 'pipe', 'pipe']
  }, sink)
  assert.equal(typeof handle.writeStdin, 'function')
  await waitFor(() => events.some(item => item[0] === 'close'))
  assert.deepEqual(
    events.filter(item => ['spawn', 'stdout', 'exit', 'close'].includes(item[0]))
      .map(item => item[0]),
    ['spawn', 'stdout', 'exit', 'close']
  )
  assert.equal(new TextDecoder().decode(events.find(item => item[0] === 'stdout')[1]), 'linux-output')
  assert.deepEqual(events.find(item => item[0] === 'exit').slice(1), [4, null])
  assert.ok(mock.commands.some(item => item.kind === 'serialWrite'))
  assert.ok(mock.commands.some(item => item.kind === 'drain'))
  await installed.close()
})

test('native HoloUV capability requests use the selected domains and original Process source', async () => {
  for (
    const [domains, command, value, expected] of [
      [[], ['system', 'read', 'os.arch'], undefined, { error: 'bridge.unavailable', ok: false, version: 1 }],
      [['system'], ['system', 'read', 'os.arch'], 'x64', { json: '"x64"', ok: true, version: 1 }],
      [['device'], ['device', 'summary'], { schemaVersion: 1 }, {
        json: '{"schemaVersion":1}',
        ok: true,
        version: 1
      }]
    ]
  ) {
    const mock = new MockNativeV86(command)
    const selectedProfile = {
      ...profile,
      environment: { ...profile.environment, capabilityBridge: { domains } }
    }
    const installed = createPrivateNativeV86ProcessProviderV1({
      installation,
      nativeV86: mock.call,
      processProfile: selectedProfile,
      policy,
      generation: 1
    })
    const calls = []
    installed.bindKernel({
      releaseResource() {},
      invokeFromSource: async (input, signal) => {
        calls.push({ input, signal })
        return value
      }
    })
    const port = new NativeV86ProcessHostPortV1(installed.registry.get('experimental.v86-v1'))
    const launch = port.prepareLaunch({
      configuration: installed.profile.backend.configuration,
      executables: installed.profile.executables,
      environmentScope: 'processTree',
      executable: installed.profile.executables[0].executable,
      executableId: 'echo',
      generation: 1,
      policy,
      runtimeArgs: []
    })
    const events = []
    const sink = Object.fromEntries([
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
    ].map(name => [name, (...args) => events.push([name, ...args])]))
    port.spawn(launch, {
      env: {},
      generation: 1,
      limits: {},
      processResourceId: 'process-capability-1',
      stdio: ['pipe', 'pipe', 'pipe']
    }, sink)
    await waitFor(() => mock.capabilityResponses.length === 1)
    assert.deepEqual(mock.capabilityResponses[0], expected)
    if (domains.length === 0) {
      assert.equal(calls.length, 0)
    } else {
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0].input.source, {
        environmentId: '1:processTree:process-capability-1',
        environmentScope: 'processTree',
        executableId: 'echo',
        kind: 'linuxProcess',
        linuxPid: 29,
        parentLinuxPid: 1,
        processResourceId: 'process-capability-1',
        rootLinuxPid: 29,
        syntheticProcessId: 23
      })
      assert.equal(calls[0].signal.aborted, false)
      assert.equal(calls[0].input.module, domains[0] === 'system' ? 'node:os' : 'holo:device/promises')
    }
    await waitFor(() => events.some(item => item[0] === 'close'))
    await installed.close()
  }
})

test('empty writes without callbacks cannot accumulate while the VM is not ready', async () => {
  let resolveEnvironment
  const pendingEnvironment = new Promise(resolve => {
    resolveEnvironment = resolve
  })
  let processSink
  let writes = 0
  let ends = 0
  let releases = 0
  const backend = {
    descriptor: { features: { shell: true, signals: true, synchronousSpawn: false } },
    spawn: () => ({
      lease: {
        environment: pendingEnvironment,
        release: async () => {
          releases += 1
        }
      },
      request: { stdio: ['pipe', 'pipe', 'pipe'] }
    })
  }
  const events = []
  const sink = Object.fromEntries([
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
  ].map(name => [name, (...args) => events.push([name, ...args])]))
  const handle = new NativeV86ProcessHostPortV1(backend).spawn({}, {}, sink)
  for (let index = 0; index < 63; index += 1) {
    assert.equal(handle.writeStdin(new Uint8Array(0), undefined), true)
  }
  for (let index = 0; index < 1000; index += 1) {
    assert.throws(
      () => handle.writeStdin(new Uint8Array(0), undefined),
      { code: 'resource.handle_limit', operation: 'process.stdin.write' }
    )
  }
  assert.equal(writes, 0)
  resolveEnvironment({
    async spawn(_request, childSink) {
      processSink = childSink
      return {
        async writeStdin() {
          writes += 1
        },
        async closeStdin() {
          ends += 1
        },
        async signal() {}
      }
    }
  })
  await waitFor(() => writes === 63)
  assert.equal(handle.writeStdin(new Uint8Array(0), undefined), true)
  await waitFor(() => writes === 64)
  handle.endStdin(undefined)
  await waitFor(() => ends === 1)
  processSink.close(0, null)
  await waitFor(() => releases === 1)
  assert.equal(events.filter(item => item[0] === 'stdinCallback').length, 65)
})

test('an asynchronous environment acquisition failure releases its lease once', async () => {
  let releases = 0
  const events = []
  const backend = {
    descriptor: { features: { shell: true, signals: true, synchronousSpawn: false } },
    spawn: () => ({
      lease: {
        environment: Promise.reject(new Error('private VM open failed')),
        release: async () => {
          releases += 1
        }
      },
      request: { stdio: ['pipe', 'pipe', 'pipe'] }
    })
  }
  const sink = Object.fromEntries([
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
  ].map(name => [name, (...args) => events.push([name, ...args])]))
  new NativeV86ProcessHostPortV1(backend).spawn({}, {}, sink)
  await waitFor(() => events.some(item => item[0] === 'close'))
  assert.deepEqual(
    events.filter(item => ['error', 'exit', 'close'].includes(item[0]))
      .map(item => item[0]),
    ['error', 'close']
  )
  assert.deepEqual(
    events.filter(item => ['stdoutError', 'stdoutClose', 'stderrError', 'stderrClose'].includes(item[0]))
      .map(item => item[0]),
    ['stdoutError', 'stdoutClose', 'stderrError', 'stderrClose']
  )
  assert.equal(events.some(item => ['spawn', 'stdoutEnd', 'stderrEnd'].includes(item[0])), false)
  assert.equal(releases, 1)
})

test('shared Provider preserves the bounded port error as a stable resource limit', () => {
  const state = {
    executableId: 'echo',
    facade: { stdin: {} },
    handle: {
      writeStdin() {
        throw new CapabilityInvocationError('resource.handle_limit', 'process.stdin.write')
      }
    },
    pendingStdinCallbacks: new Set(),
    stdinBytes: 0,
    stdinClosed: false,
    stdinEnded: false
  }
  const context = {
    arguments: '',
    operation: 'process.stdin.write',
    resource: { requested: { semanticResourceDigest: 'test' } }
  }
  const authority = {
    bindings: [{
      providerModule: 'host.process',
      capabilityName: 'host.process.execute',
      constraints: { executableIds: ['echo'], limits: { maxConcurrentProcesses: 1 } }
    }],
    complete: value => value
  }
  assert.throws(() =>
    invokeProcessResourceV1({
      authority,
      close() {},
      context,
      contracts: { CapabilityInvocationError, trustedInvocationValueFromJsonV1: value => value },
      policy: { limits: { maxStdinBytes: 1 } },
      port: { decodeInput: () => new Uint8Array(0) },
      state
    }), { code: 'resource.handle_limit', operation: 'process.stdin.write' })
  assert.equal(state.stdinBytes, 0)
  assert.equal(state.pendingStdinCallbacks.size, 0)
})
