const invalid = (): never => {
  throw new TypeError('Invalid Process supervisor network payload')
}

const processId = (value: unknown): number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 0x7FFF_FFFF
    ? value as number
    : invalid()

const ipv4 = (value: unknown): readonly number[] => {
  if (typeof value !== 'string') return invalid()
  const parts = value.split('.')
  if (
    parts.length !== 4 || parts.some(part => !/^(?:0|[1-9]\d{0,2})$/u.test(part) || Number(part) > 255)
  ) return invalid()
  return Object.freeze(parts.map(Number))
}

export interface ProcessSupervisorNetworkRequestV1 {
  readonly address: string
  readonly linuxPid: number
  readonly parentLinuxPid: number
  readonly port: number
  readonly processStartTimeTicks: number
  readonly transport: 'connect' | 'tcp' | 'udp'
}

export const encodeProcessSupervisorNetworkRequestV1 = (
  input: ProcessSupervisorNetworkRequestV1
): Uint8Array => {
  const address = ipv4(input.address)
  const linuxPid = processId(input.linuxPid)
  const parentLinuxPid = processId(input.parentLinuxPid)
  if (
    !Number.isSafeInteger(input.processStartTimeTicks) || input.processStartTimeTicks < 1 ||
    !Number.isInteger(input.port) || input.port < 1 || input.port > 65_535 ||
    !['connect', 'tcp', 'udp'].includes(input.transport)
  ) return invalid()
  const output = new Uint8Array(23)
  const view = new DataView(output.buffer)
  view.setUint32(0, linuxPid)
  view.setUint32(4, parentLinuxPid)
  view.setBigUint64(8, BigInt(input.processStartTimeTicks))
  output[16] = input.transport === 'tcp' ? 1 : input.transport === 'udp' ? 2 : 3
  output.set(address, 17)
  view.setUint16(21, input.port)
  return output
}

export const decodeProcessSupervisorNetworkRequestV1 = (
  value: Uint8Array
): ProcessSupervisorNetworkRequestV1 => {
  if (!(value instanceof Uint8Array) || value.byteLength !== 23) return invalid()
  const bytes = Uint8Array.from(value)
  const view = new DataView(bytes.buffer)
  const processStartTimeTicks = view.getBigUint64(8)
  if (processStartTimeTicks === 0n || processStartTimeTicks > BigInt(Number.MAX_SAFE_INTEGER)) return invalid()
  const transport = bytes[16] === 1 ? 'tcp' : bytes[16] === 2 ? 'udp' : bytes[16] === 3 ? 'connect' : invalid()
  const port = view.getUint16(21)
  if (port === 0) return invalid()
  return Object.freeze({
    address: [...bytes.slice(17, 21)].join('.'),
    linuxPid: processId(view.getUint32(0)),
    parentLinuxPid: processId(view.getUint32(4)),
    port,
    processStartTimeTicks: Number(processStartTimeTicks),
    transport
  })
}

export const encodeProcessSupervisorNetworkResponseV1 = (allowed: boolean): Uint8Array => {
  if (typeof allowed !== 'boolean') return invalid()
  return Uint8Array.of(allowed ? 1 : 0)
}

export const decodeProcessSupervisorNetworkResponseV1 = (value: Uint8Array): boolean => {
  if (!(value instanceof Uint8Array) || value.byteLength !== 1 || value[0]! > 1) return invalid()
  return value[0] === 1
}
