import type { DeviceOperationV1 } from './registry-types.js'

export type CanonicalResourceKindV1 =
  | 'deviceField'
  | 'filesystem'
  | 'network'
  | 'opaqueHandle'
  | 'processExecutable'
  | 'processInstance'
  | 'processNetworkEndpoint'
  | 'systemField'

export interface CanonicalResourceBaseV1 {
  readonly display: Readonly<{ label: string }>
  readonly kind: CanonicalResourceKindV1
  readonly schemaVersion: 1
  readonly semanticId: string
  readonly semanticResourceDigest: string
}

export interface FilesystemResourceV1 extends CanonicalResourceBaseV1 {
  readonly kind: 'filesystem'
  readonly pathSegments: readonly string[]
  readonly rootId: string
  readonly virtualUrl: `holo-fs://${string}/${string}`
}

export interface NetworkResourceV1 extends CanonicalResourceBaseV1 {
  readonly kind: 'network'
  readonly method: string
  readonly origin: string
  readonly pathname: string
  readonly queryDigest?: string
}

export interface DeviceFieldResourceV1 extends CanonicalResourceBaseV1 {
  readonly field: string
  readonly kind: 'deviceField'
  readonly operation: DeviceOperationV1
  readonly privacyTier: 0 | 1 | 2 | 3
}

export interface OpaqueHandleResourceV1 extends CanonicalResourceBaseV1 {
  readonly bridgeIdentityDigest: string
  readonly generation: number
  readonly kind: 'opaqueHandle'
  readonly resourceType: string
  readonly rightsDigest: string
}

export interface ProcessExecutableResourceBaseV1 extends CanonicalResourceBaseV1 {
  readonly cwdSemanticResourceDigest?: string
  readonly environmentScope: 'processTree' | 'runtime'
  readonly environmentNamesDigest: string
  readonly kind: 'processExecutable'
  readonly stdioDigest: string
}

export type ProcessExecutableResourceV1 =
  | (
    & ProcessExecutableResourceBaseV1
    & Readonly<{
      argvDigest: string
      executableId: string
      invocation: 'program'
    }>
  )
  | (
    & ProcessExecutableResourceBaseV1
    & Readonly<{
      commandDigest: string
      invocation: 'shell'
      shellExecutableId: string
    }>
  )

export interface ProcessInstanceResourceV1 extends CanonicalResourceBaseV1 {
  readonly executableSemanticResourceDigest: string
  readonly generation: number
  readonly kind: 'processInstance'
  readonly processResourceId: string
}

export interface ProcessNetworkEndpointResourceV1 extends CanonicalResourceBaseV1 {
  readonly hostname: string
  readonly kind: 'processNetworkEndpoint'
  readonly port: number
  readonly transport: 'tcp' | 'tls'
}

export interface SystemInformationFieldResourceV1 extends CanonicalResourceBaseV1 {
  readonly field: import('./registry-types.js').SystemInformationFieldV1
  readonly kind: 'systemField'
}

export type CanonicalResourceV1 =
  | DeviceFieldResourceV1
  | FilesystemResourceV1
  | NetworkResourceV1
  | OpaqueHandleResourceV1
  | ProcessExecutableResourceV1
  | ProcessInstanceResourceV1
  | ProcessNetworkEndpointResourceV1
  | SystemInformationFieldResourceV1

export interface InvocationResourceBindingV1 {
  readonly generation: number
  readonly hop?: number
  readonly invocationBindingDigest: string
  readonly requestId: string
  readonly semanticResourceDigest: string
  readonly subrequestId?: string
}

export interface InvocationBindingInputV1 {
  readonly authorityDigest: string
  readonly capabilityBindingDigest: string
  readonly generation: number
  readonly hop?: number
  readonly operation: string
  readonly processId: string
  readonly requestId: string
  readonly semanticResourceDigest: string
  readonly subrequestId?: string
}
