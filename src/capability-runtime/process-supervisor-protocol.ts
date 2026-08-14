export const PROCESS_SUPERVISOR_MAX_FRAME_BYTES_V1 = 1024 * 1024
export const PROCESS_SUPERVISOR_HEADER_BYTES_V1 = 20
export const PROCESS_SUPERVISOR_KERNEL_CAPABILITIES_V1 = Object.freeze(
  [
    'process',
    'fuse',
    'tun',
    'networkNamespaces',
    'cgroups',
    'fanotify',
    'seccompUserNotification'
  ] as const
)
export type ProcessSupervisorKernelCapabilityV1 = typeof PROCESS_SUPERVISOR_KERNEL_CAPABILITIES_V1[number]
export type ProcessSupervisorOperationV1 =
  | 'ack'
  | 'close'
  | 'error'
  | 'exit'
  | 'filesystemRequest'
  | 'filesystemResponse'
  | 'ready'
  | 'shutdown'
  | 'signal'
  | 'spawn'
  | 'spawned'
  | 'stderr'
  | 'stdin'
  | 'stdinClose'
  | 'stdout'

export interface ProcessSupervisorFrameV1 {
  readonly operation: ProcessSupervisorOperationV1
  readonly payload: Uint8Array
  readonly processId: number
  readonly requestId: number
  readonly sequence: number
  readonly version: 1
}
const MAGIC = 0x484F4C4F
const KERNEL_CAPABILITY_BITS = Object.freeze(
  {
    cgroups: 1 << 4,
    fanotify: 1 << 5,
    fuse: 1 << 1,
    networkNamespaces: 1 << 3,
    process: 1 << 0,
    seccompUserNotification: 1 << 6,
    tun: 1 << 2
  } as const satisfies Readonly<Record<ProcessSupervisorKernelCapabilityV1, number>>
)
const OPERATIONS = [
  'ack',
  'close',
  'error',
  'exit',
  'ready',
  'shutdown',
  'signal',
  'spawn',
  'spawned',
  'stderr',
  'stdin',
  'stdinClose',
  'stdout',
  'filesystemRequest',
  'filesystemResponse'
] as const satisfies readonly ProcessSupervisorOperationV1[]

const invalid = (): never => {
  throw new TypeError('Invalid Process supervisor frame')
}

export const encodeProcessSupervisorReadyPayloadV1 = (
  value: readonly ProcessSupervisorKernelCapabilityV1[]
): Uint8Array => {
  if (
    !Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length ||
    value.some(item => !PROCESS_SUPERVISOR_KERNEL_CAPABILITIES_V1.includes(item)) || !value.includes('process')
  ) return invalid()
  const output = new Uint8Array(4)
  const capabilities = value as readonly ProcessSupervisorKernelCapabilityV1[]
  const flags = capabilities.reduce((mask, capability) => mask | KERNEL_CAPABILITY_BITS[capability], 0)
  new DataView(output.buffer).setUint32(0, flags)
  return output
}

export const decodeProcessSupervisorReadyPayloadV1 = (
  value: Uint8Array
): readonly ProcessSupervisorKernelCapabilityV1[] => {
  if (!(value instanceof Uint8Array) || value.byteLength !== 4) return invalid()
  const flags = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0)
  const known = Object.values(KERNEL_CAPABILITY_BITS).reduce((mask, bit) => mask | bit, 0)
  if ((flags & ~known) !== 0 || (flags & KERNEL_CAPABILITY_BITS.process) === 0) return invalid()
  return Object.freeze(
    PROCESS_SUPERVISOR_KERNEL_CAPABILITIES_V1.filter(capability => (flags & KERNEL_CAPABILITY_BITS[capability]) !== 0)
  )
}

const unsigned = (value: unknown): number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xFFFFFFFF
    ? value as number
    : invalid()

const operationIndex = (value: unknown): number => {
  const index = OPERATIONS.indexOf(value as ProcessSupervisorOperationV1)
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
    ['ready', 'shutdown', 'spawn'].includes(frame.operation) && frame.processId !== 0 ||
    frame.operation === 'ready' && (frame.requestId !== 0 || frame.sequence !== 0) ||
    ['ack', 'filesystemRequest', 'filesystemResponse', 'signal', 'spawned', 'stdin', 'stdinClose']
        .includes(frame.operation) && frame.requestId === 0 ||
    ['ack', 'close', 'exit', 'signal', 'spawned', 'stderr', 'stdin', 'stdinClose', 'stdout']
        .includes(frame.operation) && frame.processId === 0 ||
    ['close', 'exit', 'stderr', 'stdout'].includes(frame.operation) && frame.requestId !== 0 ||
    !['stderr', 'stdout'].includes(frame.operation) && frame.sequence !== 0
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
      const operation = OPERATIONS[view.getUint8(9) - 1]
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
