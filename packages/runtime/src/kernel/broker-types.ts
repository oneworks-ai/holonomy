import type { CapabilityProviderResolutionPlanV1 } from './broker-resolution-types.js'
import type { TrustedInvocationValueV1 } from './broker-values.js'
import type { AuthorityBindingV1, CapabilityBindingV1, CapabilitySelectionV1 } from './capability-types.js'
import type { AdmittedRuntimeCreationV1 } from './context-types.js'
import type { CapabilityInvocationError } from './errors.js'
import type { CapabilityInvocationSourceV1 } from './invocation-source.js'
import type { JsonValueV1 } from './json-types.js'
import type { InvocationModeV1, OperationDescriptorV1 } from './operation-types.js'
import type { CanonicalResourceV1, InvocationResourceBindingV1 } from './resource-types.js'

export type CapabilityRuntimeTargetV1 = 'android' | 'desktop' | 'node'
export type CapabilityMiddlewareExecutionV1 = 'async' | 'sync'

export interface CanonicalResourceMatcherV1 {
  readonly kind?: CanonicalResourceV1['kind']
  readonly operation?: string
  readonly origin?: string
  readonly pathPrefixSegments?: readonly string[]
  readonly rootId?: string
  readonly semanticId?: string
}

export interface CapabilityInvocationSourceMatcherV1 {
  readonly environmentScope?: 'processTree' | 'runtime'
  readonly executableId?: string
  readonly kind?: 'linuxProcess'
}

export interface HoloInvocationMatcherV1 {
  readonly invocationMode?: InvocationModeV1
  readonly kind?: OperationDescriptorV1['kind']
  readonly member?: string
  readonly module?: string
  readonly operation?: string
  readonly phase?: 'requested' | 'resolved'
  readonly resource?: CanonicalResourceMatcherV1
  readonly source?: CapabilityInvocationSourceMatcherV1
}

export interface CapabilityRuntimeIdentityV1 {
  readonly engine: string
  readonly generation: number
  readonly policyDigest: string
  readonly processId: string
  readonly target: CapabilityRuntimeTargetV1
}

export interface HoloInvocationContextV1<THostContext = JsonValueV1> {
  readonly arguments: TrustedInvocationValueV1['value']
  readonly authorityBindings: readonly AuthorityBindingV1[]
  readonly capabilities: readonly CapabilityBindingV1[]
  readonly hostContext: Readonly<THostContext>
  readonly invocationMode: InvocationModeV1
  readonly kind: OperationDescriptorV1['kind']
  readonly member: string
  readonly module: string
  readonly operation: string
  readonly phase: 'requested' | 'resolved'
  /** Trusted continuation data. It is present only for system-only operations and never comes from Guest arguments. */
  readonly providerData?: TrustedInvocationValueV1['value']
  readonly requestId: string
  readonly resource: Readonly<{
    binding: InvocationResourceBindingV1
    inheritedBindingId?: string
    requested: CanonicalResourceV1
    resolved?: CanonicalResourceV1
  }>
  readonly runtime: CapabilityRuntimeIdentityV1
  readonly signal: AbortSignal
  readonly source?: CapabilityInvocationSourceV1
  readonly state: Map<unknown, unknown>
}

export type HoloMiddlewareNextV1 = () => TrustedInvocationValueV1 | Promise<TrustedInvocationValueV1>
export type HoloMiddlewareV1<THostContext = JsonValueV1> = (
  context: HoloInvocationContextV1<THostContext>,
  next: HoloMiddlewareNextV1
) => TrustedInvocationValueV1 | Promise<TrustedInvocationValueV1>

export interface HoloMiddlewareRegistrationV1<THostContext = JsonValueV1> {
  readonly execution: CapabilityMiddlewareExecutionV1
  readonly layer: 'application' | 'embedder'
  readonly matcher: HoloInvocationMatcherV1
  readonly middleware: HoloMiddlewareV1<THostContext>
  readonly registrationId: string
  readonly timeoutMs?: number
}

export interface InitialMiddlewareSetV1<THostContext = JsonValueV1> {
  readonly registrations: readonly HoloMiddlewareRegistrationV1<THostContext>[]
  readonly schemaVersion: 1
}

export interface CapabilityProviderReceiptV1 {
  readonly authorityDigest: string
  readonly invocationBindingDigest: string
  readonly providerModule: string
}

export interface CapabilityProviderTerminalV1 {
  readonly receipt: CapabilityProviderReceiptV1
  readonly resources?: readonly CapabilityProviderResourcePublicationV1[]
  readonly result: TrustedInvocationValueV1
}

export interface CapabilityProviderResourcePublicationV1 {
  readonly bindingId: string
  readonly eventSchemaId?: string
  readonly resource?: CanonicalResourceV1
  readonly resourceType: string
  close?(reason: 'cancelled' | 'closed' | 'generation-stale'): void | Promise<void>
  subscribe?(listener: (event: TrustedInvocationValueV1) => void): () => void
}

export interface CapabilityProviderAuthorityV1 {
  readonly bindings: readonly AuthorityBindingV1[]
  readonly invocationBinding: InvocationResourceBindingV1
  readonly providerModule: string
  complete(
    result: TrustedInvocationValueV1,
    resources?: readonly CapabilityProviderResourcePublicationV1[]
  ): CapabilityProviderTerminalV1
}

export interface CapabilityBrokerProviderV1<THostContext = JsonValueV1> {
  readonly execution: CapabilityMiddlewareExecutionV1
  readonly module: string
  invoke(
    context: HoloInvocationContextV1<THostContext>,
    authority: CapabilityProviderAuthorityV1
  ): CapabilityProviderTerminalV1 | Promise<CapabilityProviderTerminalV1>
  preflight?(
    context: HoloInvocationContextV1<THostContext>,
    authority: CapabilityProviderAuthorityV1
  ):
    | CapabilityProviderResolutionPlanV1<THostContext>
    | Promise<CapabilityProviderResolutionPlanV1<THostContext> | undefined>
    | undefined
}

export interface CapabilitySystemMiddlewareRegistrationV1<THostContext = JsonValueV1>
  extends Omit<HoloMiddlewareRegistrationV1<THostContext>, 'layer'>
{
  readonly layer: 'embedder'
}

export interface CapabilityBrokerInvocationV1 {
  readonly arguments: TrustedInvocationValueV1
  readonly inheritedBindingId?: string
  readonly invocationMode: InvocationModeV1
  readonly member: string
  readonly module: string
  readonly preferredProviderModule?: string
  readonly providerData?: TrustedInvocationValueV1
  readonly requestId: string
  readonly resource: CanonicalResourceV1
  readonly signal?: AbortSignal
  readonly source?: CapabilityInvocationSourceV1
}

export interface CapabilityBrokerAdmissionV1 {
  readonly admitted: AdmittedRuntimeCreationV1
  readonly descriptor: OperationDescriptorV1
  readonly resource: CanonicalResourceV1
  readonly selection: CapabilitySelectionV1
}

export interface CapabilityBrokerTerminalV1 {
  readonly error?: CapabilityInvocationError
  readonly result?: TrustedInvocationValueV1
}
