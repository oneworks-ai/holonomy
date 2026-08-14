import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

// eslint-disable-next-line antfu/no-import-dist -- Adapter production code consumes the built contract.
import {
  ProcessSupervisorFrameDecoderV1,
  encodeProcessSupervisorFrameV1,
  encodeProcessSupervisorReadyPayloadV1
} from '../../../dist/capability-runtime/index.js'
import { createSupervisorProcessEnvironmentFactoryV1 } from '../src/capability-process-supervisor-environment.mjs'
import { encodeCompletionPayload, encodeSpawnedPayload } from '../src/capability-process-supervisor-frames.mjs'

const frame = (operation, values = {}) => ({
  operation,
  payload: values.payload ?? new Uint8Array(),
  processId: values.processId ?? 0,
  requestId: values.requestId ?? 0,
  sequence: values.sequence ?? 0,
  version: 1
})

const request = signal => ({
  configuration: { image: 'fixture' },
  environmentId: '7:runtime',
  generation: 7,
  policy: { access: 'sandboxed' },
  scope: 'runtime',
  signal
})

test('maps framed supervisor commands to one environment process', async () => {
  const hostDecoder = new ProcessSupervisorFrameDecoderV1()
  const outbound = []
  const filesystemRequests = []
  let settleLateFilesystem
  let callbacks
  const factory = createSupervisorProcessEnvironmentFactoryV1({
    handleFilesystemRequest(input) {
      filesystemRequests.push(input)
      if (input.payload[0] === 4) {
        return new Promise(resolve => {
          settleLateFilesystem = resolve
        })
      }
      return Uint8Array.of(9, 8, 7)
    },
    async openTransport(input) {
      callbacks = input
      queueMicrotask(() =>
        input.onBytes(encodeProcessSupervisorFrameV1(frame('ready', {
          payload: encodeProcessSupervisorReadyPayloadV1(['process', 'networkNamespaces'])
        })))
      )
      return {
        async close() {},
        async write(bytes) {
          for (const item of hostDecoder.push(bytes)) {
            outbound.push(item.operation)
            if (item.operation === 'spawn') {
              input.onBytes(encodeProcessSupervisorFrameV1(frame('spawned', {
                payload: encodeSpawnedPayload(901),
                processId: 41,
                requestId: item.requestId
              })))
            } else if (['signal', 'stdin', 'stdinClose'].includes(item.operation)) {
              input.onBytes(encodeProcessSupervisorFrameV1(frame('ack', {
                processId: item.processId,
                requestId: item.requestId
              })))
            }
          }
        }
      }
    }
  })
  const controller = new AbortController()
  const environment = await factory.open(request(controller.signal))
  assert.deepEqual(environment.kernelCapabilities, ['process', 'networkNamespaces'])
  const events = []
  const process = await environment.spawn({
    args: ['hello'],
    cwd: '/',
    env: { LANG: 'C' },
    executable: { kind: 'guestPath', path: '/bin/echo' },
    executableId: 'echo',
    processResourceId: 'process-1',
    signal: controller.signal,
    stdio: ['pipe', 'pipe', 'pipe']
  }, {
    close: (code, signal) => events.push(['close', code, signal]),
    error: error => events.push(['error', error.code]),
    exit: (code, signal) => events.push(['exit', code, signal]),
    stderr: chunk => events.push(['stderr', Buffer.from(chunk).toString()]),
    stdout: chunk => events.push(['stdout', Buffer.from(chunk).toString()])
  })

  await process.writeStdin(Buffer.from('input'))
  await process.closeStdin()
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('filesystemRequest', {
    payload: Uint8Array.of(1, 2, 3),
    processId: 41,
    requestId: 77
  })))
  await new Promise(resolve => setImmediate(resolve))
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('filesystemRequest', {
    payload: Uint8Array.of(4, 5, 6),
    processId: 41,
    requestId: 78
  })))
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('stdout', {
    payload: Buffer.from('output'),
    processId: 41
  })))
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('exit', {
    payload: encodeCompletionPayload(7, null),
    processId: 41
  })))
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('close', {
    payload: encodeCompletionPayload(7, null),
    processId: 41
  })))

  assert.deepEqual(events, [
    ['stdout', 'output'],
    ['exit', 7, null],
    ['close', 7, null]
  ])
  assert.deepEqual(outbound, ['spawn', 'stdin', 'stdinClose', 'filesystemResponse'])
  assert.deepEqual(
    filesystemRequests.map(item => ({
      environmentId: item.environmentId,
      generation: item.generation,
      payload: [...item.payload],
      processId: item.processId,
      requestId: item.requestId,
      scope: item.scope
    })),
    [{
      environmentId: '7:runtime',
      generation: 7,
      payload: [1, 2, 3],
      processId: 41,
      requestId: 77,
      scope: 'runtime'
    }, {
      environmentId: '7:runtime',
      generation: 7,
      payload: [4, 5, 6],
      processId: 41,
      requestId: 78,
      scope: 'runtime'
    }]
  )
  await environment.close('generation-stale')
  settleLateFilesystem(Uint8Array.of(6, 5, 4))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(outbound, ['spawn', 'stdin', 'stdinClose', 'filesystemResponse', 'shutdown'])
})
