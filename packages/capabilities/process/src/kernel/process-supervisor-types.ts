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
export const PROCESS_SUPERVISOR_OPERATIONS_V1 = Object.freeze(
  [
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
    'filesystemResponse',
    'execRequest',
    'execResponse',
    'configure',
    'capabilityRequest',
    'capabilityResponse'
  ] as const
)

export type ProcessSupervisorKernelCapabilityV1 = typeof PROCESS_SUPERVISOR_KERNEL_CAPABILITIES_V1[number]
export type ProcessSupervisorOperationV1 = typeof PROCESS_SUPERVISOR_OPERATIONS_V1[number]

export interface ProcessSupervisorFrameV1 {
  readonly operation: ProcessSupervisorOperationV1
  readonly payload: Uint8Array
  readonly processId: number
  readonly requestId: number
  readonly sequence: number
  readonly version: 1
}

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
