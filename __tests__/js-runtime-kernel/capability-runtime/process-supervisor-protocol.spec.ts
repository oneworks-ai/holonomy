import { describe, expect, it } from 'vitest'

import {
  LinuxProcessExecutionCapabilityBridgeV1,
  decodeProcessSupervisorExecRequestV1,
  decodeProcessSupervisorExecResponseV1,
  encodeProcessSupervisorExecRequestV1,
  encodeProcessSupervisorExecResponseV1
} from '../../../src/capability-runtime/process-supervisor-exec.js'
import {
  decodeProcessSupervisorNetworkRequestV1,
  decodeProcessSupervisorNetworkResponseV1,
  encodeProcessSupervisorNetworkRequestV1,
  encodeProcessSupervisorNetworkResponseV1
} from '../../../src/capability-runtime/process-supervisor-network.js'
import {
  ProcessSupervisorFrameDecoderV1,
  decodeProcessSupervisorReadyPayloadV1,
  encodeProcessSupervisorFrameV1,
  encodeProcessSupervisorReadyPayloadV1
} from '../../../src/capability-runtime/process-supervisor-protocol.js'

const frame = {
  operation: 'stdout',
  payload: Uint8Array.from([0, 1, 2, 255]),
  processId: 17,
  requestId: 0,
  sequence: 3,
  version: 1
} as const

describe('process supervisor frame protocol', () => {
  it('decodes arbitrary binary payloads and split length prefixes', () => {
    const first = encodeProcessSupervisorFrameV1(frame)
    const secondFrame = { ...frame, operation: 'close' as const, payload: new Uint8Array(), sequence: 0 }
    const second = encodeProcessSupervisorFrameV1(secondFrame)
    const bytes = Uint8Array.from([...first, ...second])
    const decoder = new ProcessSupervisorFrameDecoderV1()

    expect(decoder.push(bytes.slice(0, 2))).toEqual([])
    expect(decoder.push(bytes.slice(2, first.length + 5))).toEqual([frame])
    expect(decoder.push(bytes.slice(first.length + 5))).toEqual([secondFrame])
    expect(() => decoder.finish()).not.toThrow()
  })

  it('rejects unknown magic, oversized, and truncated frames', () => {
    const unknownMagic = encodeProcessSupervisorFrameV1(frame)
    unknownMagic[4] = 0
    expect(() => new ProcessSupervisorFrameDecoderV1().push(unknownMagic)).toThrow(TypeError)

    const oversized = new Uint8Array(4)
    new DataView(oversized.buffer).setUint32(0, 1024 * 1024 + 1)
    expect(() => new ProcessSupervisorFrameDecoderV1().push(oversized)).toThrow(TypeError)

    const decoder = new ProcessSupervisorFrameDecoderV1()
    decoder.push(encodeProcessSupervisorFrameV1(frame).slice(0, 5))
    expect(() => decoder.finish()).toThrow(TypeError)
  })

  it('keeps environment frames and process frames in separate identities', () => {
    expect(() => encodeProcessSupervisorFrameV1({ ...frame, operation: 'spawn', processId: 1 })).toThrow(TypeError)
    expect(() =>
      encodeProcessSupervisorFrameV1({
        operation: 'ready',
        payload: encodeProcessSupervisorReadyPayloadV1(['process', 'networkNamespaces']),
        processId: 0,
        requestId: 0,
        sequence: 0,
        version: 1
      })
    ).not.toThrow()
    expect(() =>
      encodeProcessSupervisorFrameV1({
        operation: 'configure',
        payload: Uint8Array.of(1, 0, 0, 0),
        processId: 0,
        requestId: 1,
        sequence: 0,
        version: 1
      })
    ).not.toThrow()
    expect(() =>
      encodeProcessSupervisorFrameV1({
        operation: 'configure',
        payload: Uint8Array.of(1, 0, 0, 0),
        processId: 1,
        requestId: 1,
        sequence: 0,
        version: 1
      })
    ).toThrow(TypeError)
    expect(() =>
      encodeProcessSupervisorFrameV1({
        ...frame,
        operation: 'filesystemRequest',
        requestId: 3,
        sequence: 0
      })
    ).not.toThrow()
  })

  it('round-trips bounded kernel capabilities and rejects unknown feature bits', () => {
    expect(decodeProcessSupervisorReadyPayloadV1(
      encodeProcessSupervisorReadyPayloadV1(['process', 'fuse', 'networkNamespaces'])
    )).toEqual(['process', 'fuse', 'networkNamespaces'])
    expect(() => encodeProcessSupervisorReadyPayloadV1(['fuse'])).toThrow(TypeError)
    expect(() => decodeProcessSupervisorReadyPayloadV1(Uint8Array.of(0, 0, 0, 0x81))).toThrow(TypeError)
  })

  it('round-trips bounded descendant exec requests and decisions', () => {
    const request = {
      argv: ['/bin/tool', '--version'],
      cwd: '/workspace',
      linuxPid: 91,
      parentLinuxPid: 41,
      path: '/bin/tool',
      processStartTimeTicks: 123
    }
    expect(decodeProcessSupervisorExecRequestV1(encodeProcessSupervisorExecRequestV1(request))).toEqual(request)
    expect(decodeProcessSupervisorExecResponseV1(encodeProcessSupervisorExecResponseV1(true))).toBe(true)
    expect(decodeProcessSupervisorExecResponseV1(encodeProcessSupervisorExecResponseV1(false))).toBe(false)
    expect(() => encodeProcessSupervisorExecRequestV1({ ...request, path: 'relative' })).toThrow(TypeError)
    expect(() => decodeProcessSupervisorExecResponseV1(Uint8Array.of(2))).toThrow(TypeError)
  })

  it('round-trips bounded Linux network attribution and rejects malformed endpoints', () => {
    const request = {
      address: '192.0.2.17',
      linuxPid: 91,
      parentLinuxPid: 41,
      port: 443,
      processStartTimeTicks: 123,
      transport: 'tcp' as const
    }
    expect(
      decodeProcessSupervisorNetworkRequestV1(encodeProcessSupervisorNetworkRequestV1(request))
    ).toEqual(request)
    expect(
      decodeProcessSupervisorNetworkRequestV1(encodeProcessSupervisorNetworkRequestV1({
        ...request,
        address: '192.168.86.1',
        port: 80,
        transport: 'connect'
      })).transport
    ).toBe('connect')
    expect(decodeProcessSupervisorNetworkResponseV1(encodeProcessSupervisorNetworkResponseV1(true))).toBe(true)
    expect(() => encodeProcessSupervisorNetworkRequestV1({ ...request, address: '192.0.2.999' })).toThrow(TypeError)
    expect(() => decodeProcessSupervisorNetworkResponseV1(Uint8Array.of(2))).toThrow(TypeError)
  })

  it('preserves the admitted Linux child pid in descendant authorization arguments', async () => {
    let invocation: Readonly<Record<string, unknown>> | undefined
    const bridge = new LinuxProcessExecutionCapabilityBridgeV1().bind(input => {
      invocation = input
      return Promise.resolve({
        authorized: true,
        generation: 1,
        invocationBindingDigest: '1'.repeat(64),
        semanticResourceDigest: '2'.repeat(64)
      })
    })
    await bridge.authorize({
      argv: ['/bin/tool', '--version'],
      callerExecutableId: 'shell',
      cwd: '/workspace',
      environmentId: 'environment-1',
      executableId: 'tool',
      linuxPid: 91,
      parentLinuxPid: 41,
      path: '/bin/tool',
      processStartTimeTicks: 123,
      policy: {
        access: 'sandboxed',
        environment: { allowedNames: [], maxValueBytes: 1 },
        executables: [{ argumentBytes: 4096, executableId: 'tool' }],
        limits: {
          maxConcurrentProcesses: 1,
          maxExecutionTimeMs: 1000,
          maxOpenPipes: 3,
          maxProcessTreeDepth: 2,
          maxStderrBytes: 4096,
          maxStdinBytes: 4096,
          maxStdoutBytes: 4096,
          maxTotalProcesses: 4,
          maxWritableRootfsBytes: 4096
        },
        mounts: [],
        network: { access: 'none' },
        shell: { access: 'none' }
      },
      processId: 7,
      processResourceId: 'process-1',
      rootLinuxPid: 40,
      scope: 'runtime'
    })
    expect(invocation?.arguments).toMatchObject({ linuxPid: 91, parentLinuxPid: 41, processStartTimeTicks: 123 })
    expect(invocation?.source).toMatchObject({ executableId: 'shell', linuxPid: 91 })
  })
})
