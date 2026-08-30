import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel/errors'
import { encodeUtf8, utf8ByteLength } from '@holonomyjs/runtime/node-compat/utf8'
import type { ProcessSandboxV2 } from './policy-process-types.js'

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
    !Number.isInteger(input.parentLinuxPid) || input.parentLinuxPid < 1 || input.parentLinuxPid > 0x7FFF_FFFF
  ) return invalid()
  const encoded = [path, cwd, ...argv].map(encodeUtf8)
  const size = 8 + 4 + encoded[0]!.byteLength + 4 + encoded[1]!.byteLength + 2 +
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
  const string = (value: Uint8Array) => {
    u32(value.byteLength)
    output.set(value, offset)
    offset += value.byteLength
  }
  u32(input.linuxPid)
  u32(input.parentLinuxPid)
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
  const path = string()
  const cwd = string()
  const count = u16()
  if (linuxPid === 0 || parentLinuxPid === 0 || count === 0 || count > MAX_ARGUMENTS) return invalid()
  const argv = Object.freeze(Array.from({ length: count }, string))
  if (offset !== bytes.byteLength || !path.startsWith('/') || !cwd.startsWith('/')) return invalid()
  return Object.freeze({ argv, cwd, linuxPid, parentLinuxPid, path })
}

export const encodeProcessSupervisorExecResponseV1 = (allowed: boolean): Uint8Array => {
  if (typeof allowed !== 'boolean') return invalid()
  return Uint8Array.of(allowed ? 1 : 0)
}

export const decodeProcessSupervisorExecResponseV1 = (value: Uint8Array): boolean => {
  if (!(value instanceof Uint8Array) || value.byteLength !== 1 || value[0]! > 1) return invalid()
  return value[0] === 1
}

export interface LinuxProcessExecutionBridgeInputV1 {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly environmentId: string
  readonly executableId: string
  readonly linuxPid: number
  readonly parentLinuxPid: number
  readonly path: string
  readonly policy: ProcessSandboxV2
  readonly processId: number
  readonly processResourceId: string
  readonly rootLinuxPid: number
  readonly scope: 'processTree' | 'runtime'
}

export interface LinuxProcessExecutionAuthorizationReceiptV1 {
  readonly authorized: true
  readonly generation: number
  readonly invocationBindingDigest: string
  readonly semanticResourceDigest: string
}

export class LinuxProcessExecutionCapabilityBridgeV1 {
  #invoke?: (input: Readonly<Record<string, unknown>>) => Promise<unknown>

  bind(invoke: (input: Readonly<Record<string, unknown>>) => Promise<unknown>): this {
    if (this.#invoke != null || typeof invoke !== 'function') {
      throw new TypeError('Invalid Linux process execution binding')
    }
    this.#invoke = invoke
    return this
  }

  async authorize(
    input: LinuxProcessExecutionBridgeInputV1
  ): Promise<LinuxProcessExecutionAuthorizationReceiptV1> {
    if (this.#invoke == null) {
      throw new CapabilityInvocationError('provider.unavailable', 'process.program.spawn')
    }
    const policy = input.policy
    if (policy.access !== 'sandboxed') {
      throw new CapabilityInvocationError('policy.denied', 'process.program.spawn')
    }
    const executable = policy.executables.find(candidate => candidate.executableId === input.executableId)
    const argumentBytes = input.argv.slice(1).reduce((sum, value) => sum + utf8ByteLength(value), 0)
    if (executable == null || argumentBytes > executable.argumentBytes) {
      throw new CapabilityInvocationError('policy.denied', 'process.program.spawn')
    }
    const value = await this.#invoke(Object.freeze({
      arguments: Object.freeze({
        argv: Object.freeze([...input.argv]),
        cwd: input.cwd,
        environmentId: input.environmentId,
        environmentScope: input.scope,
        executableId: input.executableId,
        linuxPid: input.linuxPid,
        parentLinuxPid: input.parentLinuxPid,
        path: input.path
      }),
      member: 'authorizeDescendantProcess',
      mode: 'promise',
      module: 'holo:runtime',
      source: Object.freeze({
        environmentId: input.environmentId,
        environmentScope: input.scope,
        executableId: input.executableId,
        kind: 'linuxProcess',
        linuxPid: input.rootLinuxPid,
        parentLinuxPid: input.parentLinuxPid,
        processResourceId: input.processResourceId,
        syntheticProcessId: input.processId
      })
    })) as Partial<LinuxProcessExecutionAuthorizationReceiptV1>
    if (
      value?.authorized !== true || !Number.isSafeInteger(value.generation) ||
      typeof value.invocationBindingDigest !== 'string' ||
      typeof value.semanticResourceDigest !== 'string'
    ) {
      throw new CapabilityInvocationError('provider.protocol_error', 'process.program.spawn')
    }
    return Object.freeze(value as LinuxProcessExecutionAuthorizationReceiptV1)
  }
}
