import type { ChildProcessEnvironmentConfigurationV1 } from '@holonomyjs/capability-process/kernel/guest-child-process-support'
import { sha256Hex } from '../module-loader/sha256.js'
import { RuntimeBuffer } from '../node-compat/buffer.js'
import { decodeBase64 } from '../node-compat/encoding.js'
import type { JsonValueV1 } from './json-types.js'

export interface CapabilityGuestConfigurationV1 {
  readonly context: JsonValueV1
  readonly processEnvironment?: ChildProcessEnvironmentConfigurationV1
  readonly processShellExecutableId?: string
  readonly process?: Readonly<{
    readonly arch: string
    readonly argv: readonly string[]
    readonly platform: string
    readonly versions: Readonly<{ readonly node: string }>
  }>
  readonly processControl?: Readonly<{ exit(code: number): void }>
  readonly stdio?: Readonly<{ write(stream: 'stderr' | 'stdout', chunk: unknown): unknown }>
}

export interface CapabilityGuestBridgeV1 {
  invoke(requestJson: string, signal?: CapabilityGuestAbortSignalV1): Promise<string>
  invokeImmediate?(requestJson: string): string
  invokeSync(requestJson: string): string
  releaseResource?(bindingId: string): void
  subscribeResource?(bindingId: string, listener: (eventJson: string) => void): () => void
}

export interface CapabilityGuestAbortSignalV1 {
  add(listener: () => void): void
  readAborted(): boolean
  remove(listener: () => void): void
}

interface CapabilityTerminalV1 {
  readonly error?: Readonly<{
    code: string
    message: string
    name: string
    retryable: boolean
  }>
  readonly ok: boolean
  readonly value?: unknown
}

const createError = (snapshot: NonNullable<CapabilityTerminalV1['error']>): Error => {
  const error = new Error(snapshot.message)
  error.name = snapshot.name
  Object.defineProperties(error, {
    code: { enumerable: true, value: snapshot.code },
    retryable: { enumerable: true, value: snapshot.retryable }
  })
  return error
}

export const readCapabilityTerminalV1 = (source: string): unknown => {
  const value = JSON.parse(source) as CapabilityTerminalV1
  if (value.ok !== true) throw createError(value.error!)
  return reviveCapabilityValueV1(value.value)
}

export const readCapabilityResourceEventV1 = (source: string): unknown => reviveCapabilityValueV1(JSON.parse(source))

const reviveCapabilityValueV1 = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reviveCapabilityValueV1)
  if (value == null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (
    typeof record.base64 === 'string' && typeof record.byteLength === 'number' &&
    typeof record.sha256 === 'string' && Object.keys(record).length === 3
  ) {
    const bytes = decodeBase64(record.base64)
    if (bytes.byteLength !== record.byteLength || sha256Hex(bytes) !== record.sha256) {
      throw new TypeError('Capability binary is invalid')
    }
    const output = new RuntimeBuffer(bytes.byteLength)
    output.set(bytes)
    return output
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, reviveCapabilityValueV1(child)]))
}

export const createCapabilityRequestV1 = (
  module: string,
  member: string,
  mode: 'callback' | 'promise' | 'sync',
  argumentsValue: JsonValueV1,
  fields: Readonly<Record<string, JsonValueV1>> = {}
): string => JSON.stringify({ arguments: argumentsValue, member, mode, module, ...fields })

export interface CapabilityResourceFacadeSnapshotV1 {
  readonly binding: Readonly<{ bindingId: string; generation: number }>
  readonly resourceType: string
}

export const capabilityResourceFieldsV1 = (
  value: unknown,
  resourceType: string
): Readonly<Record<string, string>> => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Capability resource is invalid')
  }
  const facade = value as Partial<CapabilityResourceFacadeSnapshotV1>
  if (
    facade.resourceType !== resourceType || facade.binding == null ||
    typeof facade.binding.bindingId !== 'string' || !Number.isSafeInteger(facade.binding.generation)
  ) throw new TypeError('Capability resource is invalid')
  return Object.freeze({ bindingId: facade.binding.bindingId, resourceType })
}

export type CapabilityFsEncodingV1 = 'base64' | 'hex' | 'utf-8' | 'utf8' | null

export const capabilityTextEncodingV1 = (value: unknown): CapabilityFsEncodingV1 => {
  const source = value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as { encoding?: unknown }).encoding
    : value
  const encoding = source === undefined ? null : source
  if (encoding !== null && !['base64', 'hex', 'utf8', 'utf-8'].includes(encoding as string)) {
    const error = new TypeError('The encoding is unsupported')
    Object.defineProperty(error, 'code', { enumerable: true, value: 'EINVAL' })
    throw error
  }
  return encoding as CapabilityFsEncodingV1
}

export const capabilityTextPathV1 = (value: unknown): string => {
  if (typeof value !== 'string') {
    const error = new TypeError('The path must be a virtual holo-fs URL string')
    Object.defineProperty(error, 'code', { enumerable: true, value: 'EINVAL' })
    throw error
  }
  return value
}

export const deepFreezeCapabilityValueV1 = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeCapabilityValueV1(child)
    Object.freeze(value)
  }
  return value
}

export const createCapabilitySyntheticBindingV1 = (namespace: object, names: readonly string[]) =>
  Object.freeze({
    descriptor: Object.freeze({ exportNames: Object.freeze([...names]) }),
    namespace: Object.freeze(namespace)
  })
