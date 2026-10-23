import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { ProcessProviderV1 } from '@holonomyjs/capability-process/host/provider'
import { ProcessResourceManagerV1 } from '@holonomyjs/capability-process/host/resources'
// Adapter integration intentionally consumes the public build output installed in packages.
// eslint-disable-next-line antfu/no-import-dist
import {
  CapabilityInvocationError,
  canonicalizeProcessInstanceResource,
  trustedInvocationValueFromJsonV1
} from '../../../dist/capability-runtime/index.js'

test('shared Process Provider accepts a non-Node event port with one resource ledger', async () => {
  const seen = { closes: [], polls: 0, signals: [], writes: [] }
  let sink
  const port = {
    descriptor: { features: { shell: false, signals: true, synchronousSpawn: false } },
    byteLengthUtf8: value => new TextEncoder().encode(value).byteLength,
    decodeInput: value => new TextEncoder().encode(value),
    describeOutput: bytes => ({
      base64: 'QQ==',
      byteLength: bytes.byteLength,
      sha256: '0'.repeat(64)
    }),
    prepareLaunch: input => ({ executableId: input.executableId, runtimeArgs: input.runtimeArgs }),
    spawn(launch, options, events) {
      assert.deepEqual(launch, { executableId: 'tool', runtimeArgs: ['fixed', 'arg'] })
      assert.equal(options.processResourceId, 'process-1')
      sink = events
      // A native command may produce events before returning its handle.
      sink.spawn()
      sink.stdout(Uint8Array.of(65))
      return {
        writeStdin(bytes, callbackId) {
          seen.writes.push([...bytes])
          sink.stdinCallback(callbackId, null)
          return true
        },
        endStdin(callbackId) {
          sink.stdinCallback(callbackId, null)
        },
        destroyStdio() {},
        signal(value) {
          seen.signals.push(value)
        }
      }
    },
    closeGeneration(value) {
      seen.closes.push(value)
    },
    poll() {
      seen.polls += 1
    }
  }
  const provider = new ProcessProviderV1(
    {
      backend: { backendId: 'mock', configuration: {} },
      environment: { allowedScopes: ['processTree'] },
      executables: [{
        executable: { kind: 'hostPath', path: '/approved' },
        executableId: 'tool',
        fixedArgs: ['fixed'],
        shell: false
      }]
    },
    {
      access: 'sandboxed',
      environment: { allowedNames: [], maxValueBytes: 1024 },
      executables: [{ executableId: 'tool', argumentBytes: 1024 }],
      limits: {
        maxConcurrentProcesses: 1,
        maxExecutionTimeMs: 1000,
        maxOpenPipes: 3,
        maxStderrBytes: 1024,
        maxStdinBytes: 1024,
        maxStdoutBytes: 1024,
        maxTotalProcesses: 1
      }
    },
    9,
    port,
    { CapabilityInvocationError, canonicalizeProcessInstanceResource, trustedInvocationValueFromJsonV1 }
  )
  const authority = {
    bindings: [{
      capabilityName: 'host.process.execute',
      constraints: { executableIds: ['tool'], limits: { maxConcurrentProcesses: 1 } },
      providerModule: 'host.process'
    }],
    complete: (value, publications) => ({ value, publications })
  }
  const terminal = provider.invoke({
    arguments: { args: ['arg'], environmentScope: 'processTree', options: { stdio: ['pipe', 'pipe', 'ignore'] } },
    member: 'spawn',
    operation: 'process.program.spawn',
    resource: {
      requested: {
        environmentScope: 'processTree',
        executableId: 'tool',
        invocation: 'program',
        kind: 'processExecutable',
        semanticResourceDigest: '1'.repeat(64)
      }
    },
    runtime: { generation: 9 }
  }, authority)
  assert.equal(terminal.value.value.pid, 2)
  const events = []
  const child = terminal.publications.find(item => item.resourceType === 'process.child')
  const stdout = terminal.publications.find(item => item.resourceType === 'process.readable')
  const stdin = terminal.publications.find(item => item.resourceType === 'process.stdin')
  child.subscribe(event => events.push(event.value.event))
  stdout.subscribe(event => events.push(event.value.event))
  await new Promise(resolve => queueMicrotask(resolve))
  assert.deepEqual(events, ['spawn', 'data'])
  const callbacks = []
  stdin.subscribe(event => callbacks.push(JSON.parse(JSON.stringify(event.value))))
  const write = provider.invoke({
    arguments: 'x',
    member: 'ChildProcess.stdin.write',
    operation: 'process.stdin.write',
    providerData: { callbackId: 7 },
    resource: { inheritedBindingId: stdin.bindingId, requested: stdin.resource },
    runtime: { generation: 9 }
  }, authority)
  assert.equal(write.value.value, true)
  assert.deepEqual(seen.writes, [[120]])
  assert.deepEqual(callbacks, [{ callbackId: 7, error: null, event: 'callback' }])
  assert.deepEqual(provider.poll(), [])
  assert.equal(seen.polls, 1)
  await provider.close()
  assert.deepEqual(seen.signals, ['SIGKILL'])
  sink.exit(0, null)
  sink.close(0, null)
  assert.deepEqual(seen.closes, [9])
})

test('bounds pre-return port events before publishing a Process resource', () => {
  for (const chunks of [Array.from({ length: 257 }, () => Uint8Array.of(1)), [new Uint8Array(256 * 1024 + 1)]]) {
    const signals = []
    const port = {
      spawn(_launch, _options, sink) {
        for (const bytes of chunks) sink.stdout(bytes)
        return {
          writeStdin() {
            return true
          },
          endStdin() {},
          destroyStdio() {},
          signal(value) {
            signals.push(value)
          }
        }
      }
    }
    const manager = new ProcessResourceManagerV1(
      {
        limits: {
          maxConcurrentProcesses: 1,
          maxExecutionTimeMs: 1000,
          maxOpenPipes: 2,
          maxStderrBytes: 1024,
          maxStdinBytes: 1024,
          maxStdoutBytes: 1024,
          maxTotalProcesses: 1
        }
      },
      port,
      { CapabilityInvocationError, canonicalizeProcessInstanceResource, trustedInvocationValueFromJsonV1 }
    )
    assert.throws(() =>
      manager.spawn(
        { operation: 'process.program.spawn', runtime: { generation: 1 } },
        {
          complete() {
            assert.fail('unpublished resource must not complete')
          }
        },
        { semanticResourceDigest: '1'.repeat(64) },
        'tool',
        {},
        {},
        ['pipe', 'pipe', 'ignore'],
        {},
        1
      ), error => error.code === 'resource.byte_limit')
    assert.deepEqual(signals, ['SIGKILL'])
  }
})

test('bounds pending empty stdin callbacks and admits another after settlement', () => {
  let sink
  let reenter = false
  let nestedDenied = false
  let rejectNextNonEmpty = true
  let write = () => {
    throw new Error('stdin is not ready')
  }
  const port = {
    descriptor: { features: { signals: true } },
    spawn(_launch, _options, events) {
      sink = events
      return {
        writeStdin(bytes) {
          if (bytes.byteLength > 0 && rejectNextNonEmpty) {
            rejectNextNonEmpty = false
            throw new CapabilityInvocationError('resource.handle_limit', 'process.stdin.write')
          }
          if (reenter) {
            reenter = false
            assert.throws(() => write(258, 'x'), error => error.code === 'resource.byte_limit')
            nestedDenied = true
          }
          return true
        },
        endStdin() {},
        destroyStdio() {},
        signal() {}
      }
    },
    decodeInput: value => new TextEncoder().encode(value)
  }
  const manager = new ProcessResourceManagerV1(
    {
      limits: {
        maxConcurrentProcesses: 1,
        maxExecutionTimeMs: 1000,
        maxOpenPipes: 1,
        maxStderrBytes: 1024,
        maxStdinBytes: 1,
        maxStdoutBytes: 1024,
        maxTotalProcesses: 1
      }
    },
    port,
    { CapabilityInvocationError, canonicalizeProcessInstanceResource, trustedInvocationValueFromJsonV1 }
  )
  const authority = {
    bindings: [{
      capabilityName: 'host.process.execute',
      constraints: { executableIds: ['tool'], limits: { maxConcurrentProcesses: 1 } },
      providerModule: 'host.process'
    }],
    complete: (result, resources) => ({ result, resources })
  }
  const spawned = manager.spawn(
    { operation: 'process.program.spawn', runtime: { generation: 1 } },
    authority,
    { semanticResourceDigest: '1'.repeat(64) },
    'tool',
    {},
    {},
    ['pipe', 'ignore', 'ignore'],
    {},
    1
  )
  const stdin = spawned.resources.find(item => item.resourceType === 'process.stdin')
  write = (callbackId, data = '') =>
    manager.invoke(
      {
        arguments: data,
        member: 'ChildProcess.stdin.write',
        operation: 'process.stdin.write',
        providerData: { callbackId },
        resource: { inheritedBindingId: stdin.bindingId, requested: stdin.resource },
        runtime: { generation: 1 }
      },
      authority,
      stdin.resource
    )
  for (let callbackId = 1; callbackId <= 256; callbackId++) write(callbackId)
  assert.throws(() => write(257, 'x'), error => error.code === 'resource.handle_limit')
  sink.stdinCallback(256, null)
  assert.throws(() => write(257, 'x'), error => error.code === 'resource.handle_limit')
  reenter = true
  assert.doesNotThrow(() => write(257, 'x'))
  assert.equal(nestedDenied, true)
  assert.throws(() => write(258, 'x'), error => error.code === 'resource.byte_limit')
  sink.close(0, null)
})
