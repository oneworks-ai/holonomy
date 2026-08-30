import type { CapabilityBrokerPreparationOptionsV1 } from './broker-preparation.js'
import type { CapabilityProviderTerminalV1, HoloInvocationContextV1 } from './broker-types.js'
import type { TrustedInvocationValueV1 } from './broker-values.js'
import { canonicalDigest } from './canonical-json.js'
import type { CapabilitySelectionV1 } from './capability-types.js'
import { capabilityFailure } from './errors.js'
import type { OperationDescriptorV1 } from './operation-types.js'
import { normalizeResolutionEvidenceV1 } from './resolution-evidence.js'
import type { ResolutionEvidenceV1 } from './resolution-types.js'

export interface ResolutionInputV1<THostContext> {
  readonly arguments: TrustedInvocationValueV1
  readonly context: HoloInvocationContextV1<THostContext>
  readonly descriptor: OperationDescriptorV1
  readonly options: CapabilityBrokerPreparationOptionsV1<THostContext>
  readonly providerModule: string
  readonly registerTerminalOwner: (owner: (terminal: CapabilityProviderTerminalV1) => boolean) => void
  readonly selection: CapabilitySelectionV1
}

export const resolutionSelectionKeyV1 = (selection: CapabilitySelectionV1): string =>
  canonicalDigest([
    selection.branchId,
    selection.bindings.map(item => `${item.name}@${item.version}`).sort(),
    selection.authorityBindings.map(item => `${item.providerModule}:${item.capabilityName}`).sort()
  ])

export const resolutionProtocolFailureV1 = <T>(input: ResolutionInputV1<T>): never =>
  capabilityFailure(
    'provider.protocol_error',
    input.context.operation,
    input.context.resource.requested.semanticResourceDigest
  )

export const normalizeProviderResolutionEvidenceV1 = <T>(
  input: ResolutionInputV1<T>,
  value: unknown
): ResolutionEvidenceV1 => {
  try {
    return normalizeResolutionEvidenceV1(value)
  } catch {
    return resolutionProtocolFailureV1(input)
  }
}
