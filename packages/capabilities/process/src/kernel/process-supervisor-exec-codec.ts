import { encodeUtf8 } from '@holonomyjs/runtime/node-compat/utf8'

const [MAX_ARGUMENTS, MAX_STRING_BYTES] = [256, 4096]

const invalid = (): never => {
  throw new TypeError('Invalid Process supervisor exec payload')
}

const text = (value: unknown, maximum = MAX_STRING_BYTES): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    return invalid()
  }
  return value
}

export interface ProcessSupervisorExecRequestV1 {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly linuxPid: number
  readonly parentLinuxPid: number
  readonly processStartTimeTicks: number
  readonly path: string
}

export const encodeProcessSupervisorExecRequestV1 = (
  input: ProcessSupervisorExecRequestV1
): Uint8Array => {
  const argv = Array.isArray(input.argv) ? input.argv.map(value => text(value)) : invalid()
  const cwd = text(input.cwd)
  const path = text(input.path)
  if (
    !path.startsWith('/') || !cwd.startsWith('/') || argv.length === 0 || argv.length > MAX_ARGUMENTS ||
    !Number.isInteger(input.linuxPid) || input.linuxPid < 1 || input.linuxPid > 0x7FFF_FFFF ||
    !Number.isInteger(input.parentLinuxPid) || input.parentLinuxPid < 1 || input.parentLinuxPid > 0x7FFF_FFFF ||
    !Number.isSafeInteger(input.processStartTimeTicks) || input.processStartTimeTicks < 1
  ) return invalid()
  const encoded = [path, cwd, ...argv].map(encodeUtf8)
  const size = 16 + 4 + encoded[0]!.byteLength + 4 + encoded[1]!.byteLength + 2 +
    encoded.slice(2).reduce((sum, value) => sum + 4 + value.byteLength, 0)
  const output = new Uint8Array(size)
  const view = new DataView(output.buffer)
  let offset = 0
  const u16 = (value: number) => {
    view.setUint16(offset, value)
    offset += 2
  }
  const u32 = (value: number) => {
    view.setUint32(offset, value)
    offset += 4
  }
  const u64 = (value: number) => {
    view.setBigUint64(offset, BigInt(value))
    offset += 8
  }
  const string = (value: Uint8Array) => {
    u32(value.byteLength)
    output.set(value, offset)
    offset += value.byteLength
  }
  u32(input.linuxPid)
  u32(input.parentLinuxPid)
  u64(input.processStartTimeTicks)
  string(encoded[0]!)
  string(encoded[1]!)
  u16(argv.length)
  for (const value of encoded.slice(2)) string(value)
  return output
}

export const decodeProcessSupervisorExecRequestV1 = (
  value: Uint8Array
): ProcessSupervisorExecRequestV1 => {
  if (!(value instanceof Uint8Array)) return invalid()
  const bytes = new Uint8Array(value)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  const u16 = () => {
    if (offset + 2 > bytes.byteLength) return invalid()
    const output = view.getUint16(offset)
    offset += 2
    return output
  }
  const u32 = () => {
    if (offset + 4 > bytes.byteLength) return invalid()
    const output = view.getUint32(offset)
    offset += 4
    return output
  }
  const u64 = () => {
    if (offset + 8 > bytes.byteLength) return invalid()
    const output = view.getBigUint64(offset)
    offset += 8
    if (output === 0n || output > BigInt(Number.MAX_SAFE_INTEGER)) return invalid()
    return Number(output)
  }
  const string = () => {
    const length = u32()
    if (length === 0 || length > MAX_STRING_BYTES || offset + length > bytes.byteLength) return invalid()
    const source = bytes.slice(offset, offset + length)
    offset += length
    let output: string
    try {
      output = new TextDecoder('utf-8', { fatal: true }).decode(source)
    } catch {
      return invalid()
    }
    return text(output)
  }
  const linuxPid = u32()
  const parentLinuxPid = u32()
  const processStartTimeTicks = u64()
  const path = string()
  const cwd = string()
  const count = u16()
  if (linuxPid === 0 || parentLinuxPid === 0 || count === 0 || count > MAX_ARGUMENTS) return invalid()
  const argv = Object.freeze(Array.from({ length: count }, string))
  if (offset !== bytes.byteLength || !path.startsWith('/') || !cwd.startsWith('/')) return invalid()
  return Object.freeze({ argv, cwd, linuxPid, parentLinuxPid, path, processStartTimeTicks })
}

export const encodeProcessSupervisorExecResponseV1 = (allowed: boolean): Uint8Array => {
  if (typeof allowed !== 'boolean') return invalid()
  return Uint8Array.of(allowed ? 1 : 0)
}

export const decodeProcessSupervisorExecResponseV1 = (value: Uint8Array): boolean => {
  if (!(value instanceof Uint8Array) || value.byteLength !== 1 || value[0]! > 1) return invalid()
  return value[0] === 1
}

export const encodeProcessSupervisorExecResultV1 = encodeProcessSupervisorExecResponseV1
export const decodeProcessSupervisorExecResultV1 = decodeProcessSupervisorExecResponseV1
