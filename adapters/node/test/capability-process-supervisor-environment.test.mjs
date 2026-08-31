import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import {
  createHoloUvSupervisorEnvironmentFactoryV1,
  decodeHoloUvCapabilityRequestV1,
  decodeHoloUvCapabilityResponseV1,
  encodeHoloUvCapabilityRequestV1,
  encodeHoloUvCapabilityResponseV1,
  encodeHoloUvCompletionPayloadV1,
  encodeHoloUvEnvironmentConfigurationV1,
  encodeHoloUvSpawnedPayloadV1
} from '@holonomyjs/holouv'

// eslint-disable-next-line antfu/no-import-dist -- Adapter production code consumes the built contract.
import {
  ProcessSupervisorFrameDecoderV1,
  decodeProcessSupervisorExecResponseV1,
  decodeProcessSupervisorNetworkResponseV1,
  encodeProcessSupervisorExecRequestV1,
  encodeProcessSupervisorExecResultV1,
  encodeProcessSupervisorFrameV1,
  encodeProcessSupervisorNetworkRequestV1,
  encodeProcessSupervisorReadyPayloadV1
} from '../../../dist/capability-runtime/index.js'

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
  executables: [{
    executable: { kind: 'guestPath', path: '/bin/echo' },
    executableId: 'echo',
    fixedArgs: [],
    shell: false
  }, {
    executable: { kind: 'guestPath', path: '/bin/tool' },
    executableId: 'tool',
    fixedArgs: [],
    shell: false
  }],
  generation: 7,
  policy: { access: 'sandboxed' },
  scope: 'runtime',
  signal
})

test('shares one in-flight supervisor close and writes shutdown once', async () => {
  const hostDecoder = new ProcessSupervisorFrameDecoderV1()
  const outbound = []
  let closeCalls = 0
  let finishTransportClose
  const factory = createHoloUvSupervisorEnvironmentFactoryV1({
    async openTransport(input) {
      queueMicrotask(() =>
        input.onBytes(encodeProcessSupervisorFrameV1(frame('ready', {
          payload: encodeProcessSupervisorReadyPayloadV1(['process'])
        })))
      )
      return {
        close() {
          closeCalls += 1
          return new Promise(resolve => {
            finishTransportClose = resolve
          })
        },
        async write(bytes) {
          for (const item of hostDecoder.push(bytes)) outbound.push(item.operation)
        }
      }
    }
  })
  const environment = await factory.open(request(new AbortController().signal))

  const first = environment.close('cancelled')
  const second = environment.close('generation-stale')
  let secondSettled = false
  void second.then(() => {
    secondSettled = true
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.strictEqual(first, second)
  assert.equal(closeCalls, 1)
  assert.equal(secondSettled, false)
  assert.deepEqual(outbound, ['shutdown'])
  finishTransportClose()
  await Promise.all([first, second])
  assert.equal(secondSettled, true)
})

test('maps framed supervisor commands to one environment process', async () => {
  const hostDecoder = new ProcessSupervisorFrameDecoderV1()
  const outbound = []
  const filesystemRequests = []
  const executionRequests = []
  const executionResponses = []
  const networkAttributions = []
  const networkResponses = []
  const capabilityRequests = []
  const capabilityResponses = []
  let settleLateExecution
  let settleLateFilesystem
  let settleExecutionCommit
  let callbacks
  const factory = createHoloUvSupervisorEnvironmentFactoryV1({
    createConfiguration() {
      return encodeHoloUvEnvironmentConfigurationV1({
        execGateTimeoutMs: 30_000,
        hosts: [{ address: '192.168.87.1', hostname: 'example.test' }],
        version: 1
      })
    },
    handleExecutionRequest(input) {
      executionRequests.push(input)
      if (input.path === '/bin/denied') throw new Error('denied')
      if (input.path === '/bin/late') {
        return new Promise(resolve => {
          settleLateExecution = resolve
        })
      }
      return 'echo-target'
    },
    handleCapabilityRequest(input) {
      capabilityRequests.push({
        command: decodeHoloUvCapabilityRequestV1(input.payload).command,
        executableId: input.executableId,
        linuxPid: input.linuxPid,
        processId: input.processId,
        processResourceId: input.processResourceId,
        requestId: input.requestId
      })
      return encodeHoloUvCapabilityResponseV1({ json: '{"arch":"x64"}', ok: true, version: 1 })
    },
    handleFilesystemRequest(input) {
      filesystemRequests.push(input)
      if (input.payload[0] === 4) {
        return new Promise(resolve => {
          settleLateFilesystem = resolve
        })
      }
      return Uint8Array.of(9, 8, 7)
    },
    handleNetworkAttribution(input) {
      networkAttributions.push(input)
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
            if (item.operation === 'execResponse') {
              const allowed = decodeProcessSupervisorExecResponseV1(item.payload)
              executionResponses.push(allowed)
              const settle = () =>
                input.onBytes(encodeProcessSupervisorFrameV1(frame('execResult', {
                  payload: encodeProcessSupervisorExecResultV1(allowed),
                  processId: item.processId,
                  requestId: item.requestId
                })))
              if (item.requestId === 79 && allowed) settleExecutionCommit = settle
              else settle()
            }
            if (item.operation === 'capabilityResponse') {
              capabilityResponses.push(decodeHoloUvCapabilityResponseV1(item.payload))
            }
            if (item.operation === 'networkResponse') {
              networkResponses.push(decodeProcessSupervisorNetworkResponseV1(item.payload))
            }
            if (item.operation === 'configure') {
              input.onBytes(encodeProcessSupervisorFrameV1(frame('ack', {
                requestId: item.requestId
              })))
            }
            if (item.operation === 'spawn') {
              input.onBytes(encodeProcessSupervisorFrameV1(frame('spawned', {
                payload: encodeHoloUvSpawnedPayloadV1(901),
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
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('execRequest', {
    payload: encodeProcessSupervisorExecRequestV1({
      argv: ['/bin/tool', 'allowed'],
      cwd: '/workspace',
      linuxPid: 902,
      parentLinuxPid: 901,
      processStartTimeTicks: 10_002,
      path: '/bin/tool'
    }),
    processId: 41,
    requestId: 79
  })))
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('capabilityRequest', {
    payload: encodeHoloUvCapabilityRequestV1({ command: ['system', 'read', 'os.arch'], version: 1 }),
    processId: 41,
    requestId: 82,
    sequence: 901
  })))
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('execRequest', {
    payload: encodeProcessSupervisorExecRequestV1({
      argv: ['/bin/denied'],
      cwd: '/workspace',
      linuxPid: 903,
      parentLinuxPid: 901,
      processStartTimeTicks: 10_003,
      path: '/bin/denied'
    }),
    processId: 41,
    requestId: 80
  })))
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('filesystemRequest', {
    payload: Uint8Array.of(4, 5, 6),
    processId: 41,
    requestId: 78
  })))
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('execRequest', {
    payload: encodeProcessSupervisorExecRequestV1({
      argv: ['/bin/late'],
      cwd: '/workspace',
      linuxPid: 904,
      parentLinuxPid: 901,
      processStartTimeTicks: 10_004,
      path: '/bin/late'
    }),
    processId: 41,
    requestId: 81
  })))
  await new Promise(resolve => setImmediate(resolve))
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('capabilityRequest', {
    payload: encodeHoloUvCapabilityRequestV1({ command: ['system', 'read', 'os.arch'], version: 1 }),
    processId: 41,
    requestId: 83,
    sequence: 902
  })))
  await new Promise(resolve => setImmediate(resolve))
  settleExecutionCommit()
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('networkRequest', {
    payload: encodeProcessSupervisorNetworkRequestV1({
      address: '192.0.2.7',
      linuxPid: 902,
      parentLinuxPid: 901,
      port: 443,
      processStartTimeTicks: 10_002,
      transport: 'connect'
    }),
    processId: 41,
    requestId: 85
  })))
  await new Promise(resolve => setImmediate(resolve))
  const networkSource = callbacks.consumeNetworkAdmission({
    address: '192.0.2.7',
    port: 443,
    transport: 'tcp'
  })
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('capabilityRequest', {
    payload: encodeHoloUvCapabilityRequestV1({ command: ['system', 'read', 'os.arch'], version: 1 }),
    processId: 41,
    requestId: 84,
    sequence: 902
  })))
  await new Promise(resolve => setImmediate(resolve))
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('stdout', {
    payload: Buffer.from('output'),
    processId: 41
  })))
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('exit', {
    payload: encodeHoloUvCompletionPayloadV1(7, null),
    processId: 41
  })))
  callbacks.onBytes(encodeProcessSupervisorFrameV1(frame('close', {
    payload: encodeHoloUvCompletionPayloadV1(7, null),
    processId: 41
  })))

  assert.deepEqual(events, [
    ['stdout', 'output'],
    ['exit', 7, null],
    ['close', 7, null]
  ])
  assert.deepEqual(outbound, [
    'configure',
    'spawn',
    'stdin',
    'stdinClose',
    'filesystemResponse',
    'capabilityResponse',
    'execResponse',
    'execResponse',
    'capabilityResponse',
    'networkResponse',
    'capabilityResponse'
  ])
  assert.deepEqual(capabilityRequests, [{
    command: ['system', 'read', 'os.arch'],
    executableId: 'echo',
    linuxPid: 901,
    processId: 41,
    processResourceId: 'process-1',
    requestId: 82
  }, {
    command: ['system', 'read', 'os.arch'],
    executableId: 'tool',
    linuxPid: 902,
    processId: 41,
    processResourceId: 'process-1',
    requestId: 84
  }])
  assert.deepEqual(capabilityResponses, [
    { json: '{"arch":"x64"}', ok: true, version: 1 },
    { error: 'bridge.failed', ok: false, version: 1 },
    { json: '{"arch":"x64"}', ok: true, version: 1 }
  ])
  assert.deepEqual(
    executionRequests.map(input => ({
      argv: input.argv,
      callerExecutableId: input.callerExecutableId,
      linuxPid: input.linuxPid,
      parentLinuxPid: input.parentLinuxPid,
      path: input.path,
      processStartTimeTicks: input.processStartTimeTicks,
      processResourceId: input.processResourceId,
      rootLinuxPid: input.rootLinuxPid
    })),
    [{
      argv: ['/bin/tool', 'allowed'],
      callerExecutableId: 'echo',
      linuxPid: 902,
      parentLinuxPid: 901,
      path: '/bin/tool',
      processStartTimeTicks: 10_002,
      processResourceId: 'process-1',
      rootLinuxPid: 901
    }, {
      argv: ['/bin/denied'],
      callerExecutableId: 'echo',
      linuxPid: 903,
      parentLinuxPid: 901,
      path: '/bin/denied',
      processStartTimeTicks: 10_003,
      processResourceId: 'process-1',
      rootLinuxPid: 901
    }, {
      argv: ['/bin/late'],
      callerExecutableId: 'echo',
      linuxPid: 904,
      parentLinuxPid: 901,
      path: '/bin/late',
      processStartTimeTicks: 10_004,
      processResourceId: 'process-1',
      rootLinuxPid: 901
    }]
  )
  assert.deepEqual(executionResponses, [true, false])
  assert.deepEqual(networkResponses, [true])
  assert.deepEqual(
    networkAttributions.map(input => ({
      address: input.address,
      executableId: input.executableId,
      linuxPid: input.linuxPid,
      parentLinuxPid: input.parentLinuxPid,
      port: input.port,
      processStartTimeTicks: input.processStartTimeTicks,
      transport: input.transport
    })),
    [{
      address: '192.0.2.7',
      executableId: 'tool',
      linuxPid: 902,
      parentLinuxPid: 901,
      port: 443,
      processStartTimeTicks: 10_002,
      transport: 'connect'
    }]
  )
  assert.deepEqual(networkSource, {
    executableId: 'tool',
    linuxPid: 902,
    parentLinuxPid: 901,
    processId: 41,
    processResourceId: 'process-1',
    processStartTimeTicks: 10_002,
    rootLinuxPid: 901
  })
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
  settleLateExecution('late-target')
  settleLateFilesystem(Uint8Array.of(6, 5, 4))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(outbound, [
    'configure',
    'spawn',
    'stdin',
    'stdinClose',
    'filesystemResponse',
    'capabilityResponse',
    'execResponse',
    'execResponse',
    'capabilityResponse',
    'networkResponse',
    'capabilityResponse',
    'shutdown'
  ])
})
