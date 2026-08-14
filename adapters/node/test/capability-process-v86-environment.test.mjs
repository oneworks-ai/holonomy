import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

// eslint-disable-next-line antfu/no-import-dist -- Adapter production code consumes the built contract.
import {
  ProcessSupervisorFrameDecoderV1,
  encodeProcessSupervisorFrameV1,
  encodeProcessSupervisorReadyPayloadV1
} from '../../../dist/capability-runtime/index.js'
import { encodeCompletionPayload } from '../src/capability-process-supervisor-frames.mjs'
import { createV86ProcessBackendV1 } from '../src/capability-process-v86-backend.mjs'
import { createV86ProcessEnvironmentFactoryV1 } from '../src/capability-process-v86-environment.mjs'

const values = new Map([
  ['bios', Uint8Array.from([1, 2, 3])],
  ['initrd', Uint8Array.from([10, 11, 12])],
  ['kernel', Uint8Array.from([4, 5, 6])],
  ['state', Uint8Array.from([7, 8, 9])],
  ['wasm', Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])]
])
const artifact = artifactId => ({
  artifactId,
  sha256: createHash('sha256').update(values.get(artifactId)).digest('hex')
})
const configuration = {
  artifacts: {
    bios: artifact('bios'),
    initialState: artifact('state'),
    initrd: artifact('initrd'),
    kernel: artifact('kernel'),
    wasm: artifact('wasm')
  },
  memoryBytes: 64 * 1024 * 1024,
  requiredKernelCapabilities: ['process'],
  supervisor: { protocolVersion: 1 }
}

class FakeV86 {
  listeners = new Map()
  sent = []

  constructor(options) {
    this.options = options
    if (options.net_device?.relay_url === 'fetch') {
      this.network_adapter = { fetch: () => Promise.resolve(new Response('unwrapped')) }
    }
    FakeV86.last = this
    queueMicrotask(() => {
      const ready = encodeProcessSupervisorFrameV1({
        operation: 'ready',
        payload: encodeProcessSupervisorReadyPayloadV1(['process', 'networkNamespaces']),
        processId: 0,
        requestId: 0,
        sequence: 0,
        version: 1
      })
      for (const byte of ready) this.emit('serial1-output-byte', byte)
    })
  }

  add_listener(name, listener) {
    this.listeners.set(name, listener)
  }

  async destroy() {
    this.destroyed = true
  }

  emit(name, value) {
    this.listeners.get(name)?.(value)
  }

  remove_listener(name, listener) {
    if (this.listeners.get(name) === listener) this.listeners.delete(name)
  }

  serial_send_bytes(index, bytes) {
    this.sent.push([index, Uint8Array.from(bytes)])
  }
}

class SupervisorV86 extends FakeV86 {
  decoder = new ProcessSupervisorFrameDecoderV1()

  output(value) {
    for (const byte of encodeProcessSupervisorFrameV1(value)) this.emit('serial1-output-byte', byte)
  }

  serial_send_bytes(index, bytes) {
    super.serial_send_bytes(index, bytes)
    for (const item of this.decoder.push(bytes)) {
      if (item.operation !== 'spawn') continue
      queueMicrotask(() => {
        this.output({
          operation: 'spawned',
          payload: Uint8Array.of(0, 0, 0, 29),
          processId: 23,
          requestId: item.requestId,
          sequence: 0,
          version: 1
        })
        this.output({
          operation: 'stdout',
          payload: Buffer.from('linux-output'),
          processId: 23,
          requestId: 0,
          sequence: 0,
          version: 1
        })
        for (const operation of ['exit', 'close']) {
          this.output({
            operation,
            payload: encodeCompletionPayload(4, null),
            processId: 23,
            requestId: 0,
            sequence: 0,
            version: 1
          })
        }
      })
    }
  }
}

class NetworkV86 extends SupervisorV86 {
  serial_send_bytes(index, bytes) {
    FakeV86.prototype.serial_send_bytes.call(this, index, bytes)
    for (const item of this.decoder.push(bytes)) {
      if (item.operation !== 'spawn') continue
      queueMicrotask(() => {
        this.output({
          operation: 'spawned',
          payload: Uint8Array.of(0, 0, 0, 41),
          processId: 37,
          requestId: item.requestId,
          sequence: 0,
          version: 1
        })
        queueMicrotask(async () => {
          NetworkV86.response = await this.network_adapter.fetch('http://127.0.0.1:8123/ping', {
            method: 'GET'
          })
          for (const operation of ['exit', 'close']) {
            this.output({
              operation,
              payload: encodeCompletionPayload(0, null),
              processId: 37,
              requestId: 0,
              sequence: 0,
              version: 1
            })
          }
        })
      })
    }
  }
}

class MissingNetworkV86 extends FakeV86 {
  constructor(options) {
    super(options)
    delete this.network_adapter
    queueMicrotask(() => this.emit('emulator-ready'))
  }
}

test('loads digest-bound v86 assets and uses the public secondary serial API', async () => {
  const factory = createV86ProcessEnvironmentFactoryV1({
    V86: FakeV86,
    loadArtifact: input => values.get(input.artifactId),
    readyTimeoutMs: 1000
  })
  const environment = await factory.open({
    configuration,
    environmentId: '7:runtime',
    generation: 7,
    policy: { access: 'sandboxed' },
    scope: 'runtime',
    signal: new AbortController().signal
  })
  assert.equal(FakeV86.last.options.memory_size, 64 * 1024 * 1024)
  assert.deepEqual([...new Uint8Array(FakeV86.last.options.bios.buffer)], [1, 2, 3])
  assert.deepEqual([...new Uint8Array(FakeV86.last.options.initrd.buffer)], [10, 11, 12])
  assert.deepEqual([...new Uint8Array(FakeV86.last.options.initial_state.buffer)], [7, 8, 9])
  assert.equal(FakeV86.last.options.uart1, true)
  assert.deepEqual(environment.kernelCapabilities, ['process', 'networkNamespaces'])

  await environment.close('generation-stale')
  assert.equal(FakeV86.last.destroyed, true)
  assert.equal(FakeV86.last.sent[0][0], 1)
  const decoder = new ProcessSupervisorFrameDecoderV1()
  assert.equal(decoder.push(FakeV86.last.sent[0][1])[0].operation, 'shutdown')
})

test('rejects a v86 artifact whose bytes do not match the Host manifest', async () => {
  const factory = createV86ProcessEnvironmentFactoryV1({
    V86: FakeV86,
    loadArtifact: input => input.artifactId === 'kernel' ? Uint8Array.of(99) : values.get(input.artifactId)
  })
  await assert.rejects(
    factory.open({
      configuration,
      environmentId: '7:runtime',
      generation: 7,
      policy: {},
      scope: 'runtime',
      signal: new AbortController().signal
    }),
    TypeError
  )
})

test('rejects a Linux kernel missing a Host-required Bridge capability', async () => {
  const factory = createV86ProcessEnvironmentFactoryV1({
    V86: FakeV86,
    loadArtifact: input => values.get(input.artifactId)
  })
  await assert.rejects(
    factory.open({
      configuration: { ...configuration, requiredKernelCapabilities: ['process', 'fuse'] },
      environmentId: '7:runtime',
      generation: 7,
      policy: {},
      scope: 'runtime',
      signal: new AbortController().signal
    }),
    TypeError
  )
})

test('maps an injected v86 supervisor through the Node ChildProcess resource', async () => {
  const backend = createV86ProcessBackendV1({
    V86: SupervisorV86,
    loadArtifact: input => values.get(input.artifactId),
    readyTimeoutMs: 1000
  })
  const launch = backend.prepareLaunch({
    configuration: backend.normalizeConfiguration(configuration),
    environmentScope: 'processTree',
    executable: backend.normalizeExecutable({ kind: 'guestPath', path: '/bin/tool' }),
    executableId: 'tool',
    generation: 9,
    policy: { access: 'sandboxed' },
    runtimeArgs: ['--fixture']
  })
  const running = backend.spawn(launch, {
    cwd: '/',
    env: { LANG: 'C' },
    stdio: ['pipe', 'pipe', 'pipe']
  }, { processResourceId: 'process-v86-1' })
  const chunks = []
  running.child.stdout.on('data', chunk => chunks.push(chunk.toString()))
  const [code, signal] = await once(running.child, 'close')
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual([code, signal], [4, null])
  assert.deepEqual(chunks, ['linux-output'])
  assert.equal(SupervisorV86.last.destroyed, true)
})

test('attributes v86 fetch traffic to the single processTree workload', async () => {
  let request
  const backend = createV86ProcessBackendV1({
    V86: NetworkV86,
    handleNetworkRequest: input => {
      request = input
      return Promise.resolve(new Response('authorized'))
    },
    loadArtifact: input => values.get(input.artifactId),
    readyTimeoutMs: 1000
  })
  const launch = backend.prepareLaunch({
    configuration: backend.normalizeConfiguration(configuration),
    environmentScope: 'processTree',
    executable: backend.normalizeExecutable({ kind: 'guestPath', path: '/bin/curl' }),
    executableId: 'curl',
    generation: 9,
    policy: { access: 'sandboxed' },
    runtimeArgs: []
  })
  const running = backend.spawn(launch, {
    cwd: '/',
    env: {},
    stdio: ['ignore', 'ignore', 'ignore']
  }, { processResourceId: 'process-network-1' })
  await once(running.child, 'close')
  assert.equal(backend.descriptor.features.networkBridge, true)
  assert.equal(await NetworkV86.response.text(), 'authorized')
  const { signal, ...actual } = request
  assert.ok(signal instanceof AbortSignal)
  assert.deepEqual(actual, {
    environmentId: '9:processTree:process-network-1',
    executableId: 'curl',
    generation: 9,
    init: { method: 'GET' },
    linuxPid: 41,
    policy: { access: 'sandboxed' },
    processId: 37,
    processResourceId: 'process-network-1',
    scope: 'processTree',
    url: 'http://127.0.0.1:8123/ping'
  })
})

test('destroys v86 when the Host-required network adapter is unavailable', async () => {
  const factory = createV86ProcessEnvironmentFactoryV1({
    V86: MissingNetworkV86,
    handleNetworkRequest: () => Promise.resolve(new Response()),
    loadArtifact: input => values.get(input.artifactId),
    readyTimeoutMs: 1000
  })
  await assert.rejects(
    factory.open({
      configuration,
      environmentId: '7:processTree:missing-network',
      generation: 7,
      policy: { access: 'sandboxed' },
      scope: 'processTree',
      signal: new AbortController().signal
    }),
    TypeError
  )
  assert.equal(MissingNetworkV86.last.destroyed, true)
})
