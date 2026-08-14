import { describe, expect, it } from 'vitest'

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
})
