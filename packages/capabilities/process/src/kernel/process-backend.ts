import type { JsonSchema } from '@holonomyjs/runtime/kernel/schema-primitives'
import { strictObject, stringSetSchema } from '@holonomyjs/runtime/kernel/schema-primitives'

export type ProcessBackendFamilyV1 = 'native' | 'virtual-kernel' | 'virtual-machine' | 'wasix'
export type ProcessBackendPlatformV1 = 'android' | 'desktop' | 'node'
export type ProcessBackendBinaryFormatV1 = 'host-native' | 'linux-x86-32' | 'packaged-wasm' | 'wasix'
export type ProcessBackendEnvironmentScopeV1 = 'processTree' | 'runtime'

export interface ProcessBackendFeaturesV1 {
  readonly filesystemBridge: boolean
  readonly networkBridge: boolean
  readonly pty: boolean
  readonly shell: boolean
  readonly signals: boolean
  readonly snapshots: boolean
  readonly synchronousSpawn: boolean
}

export interface ProcessBackendDescriptorV1 {
  readonly backendId: string
  readonly binaryFormats: readonly ProcessBackendBinaryFormatV1[]
  readonly environmentScopes: readonly ProcessBackendEnvironmentScopeV1[]
  readonly family: ProcessBackendFamilyV1
  readonly features: ProcessBackendFeaturesV1
  readonly platforms: readonly ProcessBackendPlatformV1[]
  readonly stability: 'experimental' | 'stable'
  readonly version: 1
}

export interface ProcessBackendExecutableDeclarationV1<TExecutable = unknown> {
  readonly executable: TExecutable
  readonly executableId: string
  readonly fixedArgs: readonly string[]
  readonly shell: boolean
}

export interface ProcessBackendEnvironmentOpenRequestV1<TConfiguration = unknown, TExecutable = unknown> {
  readonly configuration: TConfiguration
  readonly environmentId: string
  readonly executables: readonly ProcessBackendExecutableDeclarationV1<TExecutable>[]
  readonly generation: number
  readonly policy: unknown
  readonly scope: ProcessBackendEnvironmentScopeV1
  readonly signal: AbortSignal
}

export interface ProcessBackendSpawnRequestV1<TExecutable = unknown> {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly executable: TExecutable
  readonly executableId: string
  readonly processResourceId: string
  readonly signal: AbortSignal
  readonly stdio: readonly [
    'ignore' | 'pipe',
    'ignore' | 'pipe',
    'ignore' | 'pipe'
  ]
}

export interface ProcessBackendProcessSinkV1 {
  readonly close: (code: number | null, signal: string | null) => void
  readonly error: (error: Error) => void
  readonly exit: (code: number | null, signal: string | null) => void
  readonly stderr: (chunk: Uint8Array) => void
  readonly stdout: (chunk: Uint8Array) => void
}

export interface ProcessBackendProcessV1 {
  readonly closeStdin: () => Promise<void>
  readonly signal: (signal: string) => Promise<void>
  readonly writeStdin: (chunk: Uint8Array) => Promise<void>
}

export interface ProcessBackendEnvironmentV1<TExecutable = unknown> {
  readonly close: (reason: 'cancelled' | 'generation-stale' | 'process-complete') => Promise<void>
  readonly spawn: (
    request: ProcessBackendSpawnRequestV1<TExecutable>,
    sink: ProcessBackendProcessSinkV1
  ) => Promise<ProcessBackendProcessV1>
}

export interface ProcessBackendEnvironmentFactoryV1<TConfiguration = unknown, TExecutable = unknown> {
  readonly open: (
    request: ProcessBackendEnvironmentOpenRequestV1<TConfiguration, TExecutable>
  ) => Promise<ProcessBackendEnvironmentV1<TExecutable>>
}

const BOOLEAN_SCHEMA: JsonSchema = { type: 'boolean' }
const IDENTIFIER_SCHEMA: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  type: 'string'
}

export const PROCESS_BACKEND_DESCRIPTOR_V1_SCHEMA: JsonSchema = strictObject({
  backendId: IDENTIFIER_SCHEMA,
  binaryFormats: stringSetSchema({ enum: ['host-native', 'linux-x86-32', 'packaged-wasm', 'wasix'] }, 1, 4),
  environmentScopes: stringSetSchema({ enum: ['processTree', 'runtime'] }, 1, 2),
  family: { enum: ['native', 'virtual-kernel', 'virtual-machine', 'wasix'] },
  features: strictObject({
    filesystemBridge: BOOLEAN_SCHEMA,
    networkBridge: BOOLEAN_SCHEMA,
    pty: BOOLEAN_SCHEMA,
    shell: BOOLEAN_SCHEMA,
    signals: BOOLEAN_SCHEMA,
    snapshots: BOOLEAN_SCHEMA,
    synchronousSpawn: BOOLEAN_SCHEMA
  }),
  platforms: stringSetSchema({ enum: ['android', 'desktop', 'node'] }, 1, 3),
  stability: { enum: ['experimental', 'stable'] },
  version: { const: 1 }
})

const invalid = (): never => {
  throw new TypeError('Process Backend descriptor is invalid')
}

const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !keys.includes(key))) return invalid()
  return input
}

const identifier = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9][\w.-]{0,127}$/u.test(value) ? value : invalid()

const stringSet = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  maximum = 16
): readonly T[] => {
  if (
    !Array.isArray(value) || value.length === 0 || value.length > maximum ||
    value.some(item => typeof item !== 'string' || !allowed.includes(item as T)) ||
    new Set(value).size !== value.length
  ) return invalid()
  return Object.freeze([...value].sort()) as readonly T[]
}

export const normalizeProcessBackendDescriptorV1 = (value: unknown): ProcessBackendDescriptorV1 => {
  const input = exact(value, [
    'backendId',
    'binaryFormats',
    'environmentScopes',
    'family',
    'features',
    'platforms',
    'stability',
    'version'
  ])
  const features = exact(input.features, [
    'filesystemBridge',
    'networkBridge',
    'pty',
    'shell',
    'signals',
    'snapshots',
    'synchronousSpawn'
  ])
  if (Object.values(features).some(feature => typeof feature !== 'boolean')) return invalid()
  return Object.freeze({
    backendId: identifier(input.backendId),
    binaryFormats: stringSet(
      input.binaryFormats,
      ['host-native', 'linux-x86-32', 'packaged-wasm', 'wasix'] as const
    ),
    environmentScopes: stringSet(input.environmentScopes, ['processTree', 'runtime'] as const, 2),
    family: stringSet([input.family], ['native', 'virtual-kernel', 'virtual-machine', 'wasix'] as const, 1)[0]!,
    features: Object.freeze(features as unknown as ProcessBackendFeaturesV1),
    platforms: stringSet(input.platforms, ['android', 'desktop', 'node'] as const, 3),
    stability: stringSet([input.stability], ['experimental', 'stable'] as const, 1)[0]!,
    version: input.version === 1 ? 1 : invalid()
  })
}
