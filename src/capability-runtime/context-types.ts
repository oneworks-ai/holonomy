import type { DeviceProviderDescriptorV1 } from './device-types.js'
import type { JsonValueV1 } from './json-types.js'
import type { SandboxPolicyV2 } from './sandbox-policy.js'
import type { HostSystemProjectionV1 } from './system-types.js'

export interface RuntimeContextEnvelopeV1 {
  readonly guest?: JsonValueV1
  readonly host?: JsonValueV1
  readonly inspector?: JsonValueV1
  readonly schemaVersion: 1
}

export interface RuntimeModuleLaunchV1 {
  readonly entryUrl: string
  readonly moduleCount: number
  readonly moduleGraphDigest: string
  readonly moduleRootUrl: string
  readonly totalSourceBytes: number
}

export interface RuntimeCreationConfigurationV1 {
  readonly context: RuntimeContextEnvelopeV1
  readonly deviceProviderDescriptor?: DeviceProviderDescriptorV1
  readonly inspector: Readonly<{ enabled: boolean }>
  readonly launch: RuntimeModuleLaunchV1
  readonly sandboxPolicy: SandboxPolicyV2
  readonly schemaVersion: 1
  readonly systemProjection: HostSystemProjectionV1
}

export interface HostBindingReferenceV1 {
  readonly bindingId: string
  readonly ownerId: string
  readonly version: string
}

export interface ProviderBindingRegistrationV1 {
  readonly module: string
  readonly ownerId: string
  readonly providerId: string
  readonly providerVersion: string
}

export interface RuntimeCreationHostBindingsV1 {
  readonly engineGate: HostBindingReferenceV1
  readonly initialMiddlewareSet: HostBindingReferenceV1
  readonly initialObservers: readonly HostBindingReferenceV1[]
  readonly moduleResolver: HostBindingReferenceV1
  readonly providerBindings: readonly ProviderBindingRegistrationV1[]
}

export interface RuntimeCreationSpecV1 {
  readonly configuration: RuntimeCreationConfigurationV1
  readonly hostBindings: RuntimeCreationHostBindingsV1
}

export type RuntimeHostBindingKindV1 =
  | 'engineGate'
  | 'initialMiddlewareSet'
  | 'moduleResolver'
  | 'observer'
  | 'provider'

export interface RuntimeCreationAdmissionContextV1 {
  readonly expectedOwnerId: string
  readonly generation: number
  readonly processId: string
  readonly resolveBinding: (
    reference: HostBindingReferenceV1,
    kind: RuntimeHostBindingKindV1
  ) => unknown
}

export interface AdmittedRuntimeCreationV1 {
  readonly admissionDigest: string
  readonly configuration: RuntimeCreationConfigurationV1
  readonly configurationDigest: string
  readonly generation: number
  readonly hostBindings: RuntimeCreationHostBindingsV1
  readonly hostBindingsDigest: string
  readonly principal: string
  readonly processId: string
  readonly resolvedHostBindings: Readonly<Record<string, unknown>>
}

export interface RuntimeContextLimitsV1 {
  readonly maxArrayLength: number
  readonly maxDepth: number
  readonly maxKeys: number
  readonly maxProjectionBytes: number
  readonly maxStringBytes: number
}
