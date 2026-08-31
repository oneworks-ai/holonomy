import {
  PROCESS_SUPERVISOR_HEADER_BYTES_V1,
  PROCESS_SUPERVISOR_MAX_FRAME_BYTES_V1,
  PROCESS_SUPERVISOR_OPERATIONS_V1
} from './process-supervisor-types.js'
import type { ProcessSupervisorFrameV1, ProcessSupervisorOperationV1 } from './process-supervisor-types.js'

const MAGIC = 0x484F4C4F

const invalid = (): never => {
  throw new TypeError('Invalid Process supervisor frame')
}

const unsigned = (value: unknown): number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xFFFFFFFF
    ? value as number
    : invalid()

const operationIndex = (value: unknown): number => {
  const index = PROCESS_SUPERVISOR_OPERATIONS_V1.indexOf(value as ProcessSupervisorOperationV1)
  return index < 0 ? invalid() : index
}

export const normalizeProcessSupervisorFrameV1 = (value: unknown): ProcessSupervisorFrameV1 => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  if (
    keys.length !== 6 ||
    keys.some(key => !['operation', 'payload', 'processId', 'requestId', 'sequence', 'version'].includes(key)) ||
    input.version !== 1 || !(input.payload instanceof Uint8Array)
  ) return invalid()
  operationIndex(input.operation)
  const frame = {
    operation: input.operation as ProcessSupervisorOperationV1,
    payload: Uint8Array.from(input.payload),
    processId: unsigned(input.processId),
    requestId: unsigned(input.requestId),
    sequence: unsigned(input.sequence),
    version: 1 as const
  }
  if (
    ['configure', 'ready', 'shutdown', 'spawn'].includes(frame.operation) && frame.processId !== 0 ||
    frame.operation === 'ready' && (frame.requestId !== 0 || frame.sequence !== 0) ||
    [
        'ack',
        'capabilityRequest',
        'capabilityResponse',
        'configure',
        'execRequest',
        'execResponse',
        'execResult',
        'filesystemRequest',
        'filesystemResponse',
        'networkRequest',
        'networkResponse',
        'signal',
        'spawned',
        'stdin',
        'stdinClose'
      ]
        .includes(frame.operation) && frame.requestId === 0 ||
    [
        'close',
        'capabilityRequest',
        'capabilityResponse',
        'execRequest',
        'execResponse',
        'execResult',
        'exit',
        'networkRequest',
        'networkResponse',
        'signal',
        'spawned',
        'stderr',
        'stdin',
        'stdinClose',
        'stdout'
      ]
        .includes(frame.operation) && frame.processId === 0 ||
    ['close', 'exit', 'stderr', 'stdout'].includes(frame.operation) && frame.requestId !== 0 ||
    frame.operation === 'capabilityRequest' && frame.sequence === 0 ||
    !['capabilityRequest', 'stderr', 'stdout'].includes(frame.operation) && frame.sequence !== 0
  ) return invalid()
  return Object.freeze(frame)
}

export const encodeProcessSupervisorFrameV1 = (value: unknown): Uint8Array => {
  const frame = normalizeProcessSupervisorFrameV1(value)
  const bodyLength = PROCESS_SUPERVISOR_HEADER_BYTES_V1 + frame.payload.byteLength
  if (bodyLength > PROCESS_SUPERVISOR_MAX_FRAME_BYTES_V1) return invalid()
  const output = new Uint8Array(4 + bodyLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, bodyLength)
  view.setUint32(4, MAGIC)
  view.setUint8(8, 1)
  view.setUint8(9, operationIndex(frame.operation) + 1)
  view.setUint16(10, 0)
  view.setUint32(12, frame.requestId)
  view.setUint32(16, frame.processId)
  view.setUint32(20, frame.sequence)
  output.set(frame.payload, 24)
  return output
}

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.byteLength === 0) return Uint8Array.from(right)
  const output = new Uint8Array(left.byteLength + right.byteLength)
  output.set(left)
  output.set(right, left.byteLength)
  return output
}

export class ProcessSupervisorFrameDecoderV1 {
  #buffer: Uint8Array = new Uint8Array()

  push(chunk: Uint8Array): readonly ProcessSupervisorFrameV1[] {
    if (!(chunk instanceof Uint8Array)) return invalid()
    this.#buffer = concat(this.#buffer, chunk)
    const frames: ProcessSupervisorFrameV1[] = []
    while (this.#buffer.byteLength >= 4) {
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, this.#buffer.byteLength)
      const length = view.getUint32(0)
      if (
        length < PROCESS_SUPERVISOR_HEADER_BYTES_V1 || length > PROCESS_SUPERVISOR_MAX_FRAME_BYTES_V1
      ) return invalid()
      if (this.#buffer.byteLength < length + 4) break
      if (view.getUint32(4) !== MAGIC || view.getUint8(8) !== 1 || view.getUint16(10) !== 0) return invalid()
      const operation = PROCESS_SUPERVISOR_OPERATIONS_V1[view.getUint8(9) - 1]
      if (operation == null) return invalid()
      frames.push(normalizeProcessSupervisorFrameV1({
        operation,
        payload: this.#buffer.slice(24, 4 + length),
        processId: view.getUint32(16),
        requestId: view.getUint32(12),
        sequence: view.getUint32(20),
        version: 1
      }))
      this.#buffer = this.#buffer.slice(4 + length)
    }
    return Object.freeze(frames)
  }

  finish(): void {
    if (this.#buffer.byteLength !== 0) return invalid()
  }
}
