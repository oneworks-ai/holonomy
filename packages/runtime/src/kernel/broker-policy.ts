import { dynamicDeviceRequirementV1 } from '@holonomyjs/capability-device/kernel/broker-policy-device'
import { materializeCapabilityConstraintsV1 } from './broker-policy-constraints.js'
import type { MaterializationInputV1 } from './broker-policy-types.js'
import { CAPABILITY_DEFINITION_BY_NAME_V1 } from './capability-registry.js'
import { selectCapabilityBranchV1 } from './capability-selection.js'
import type { AvailableCapabilityV1 } from './capability-selection.js'
import type { CapabilityRequirementV1, CapabilitySelectionV1 } from './capability-types.js'
import { capabilityFailure } from './errors.js'
import type { OperationCapabilityRequirementTemplateV1 } from './operation-types.js'

const templateRequirement = (
  input: MaterializationInputV1,
  template: OperationCapabilityRequirementTemplateV1
): CapabilityRequirementV1 => ({
  anyOf: template.anyOf.filter(branch =>
    input.preferredProviderModule == null ||
    branch.allOf.some(ref =>
      CAPABILITY_DEFINITION_BY_NAME_V1.get(ref.name)?.providerModule === input.preferredProviderModule
    )
  ).map(branch => ({
    allOf: branch.allOf.map(ref => {
      const narrowed = materializeCapabilityConstraintsV1(input, ref.name, false) ?? capabilityFailure(
        'policy.denied',
        input.descriptor.operation,
        input.resource.semanticResourceDigest
      )
      return { constraints: narrowed, name: ref.name, version: 1 as const }
    }),
    branchId: branch.branchId
  }))
})

export const authorizeCapabilityInvocationV1 = (
  input: MaterializationInputV1
): CapabilitySelectionV1 => {
  const capability = input.descriptor.capability
  if ('kind' in capability && capability.kind === 'dynamic') {
    const requirement = dynamicDeviceRequirementV1(input)
    const available = requirement.anyOf[0]!.allOf.map(ref => ({
      constraints: ref.constraints,
      name: ref.name,
      version: 1 as const
    }))
    return selectCapabilityBranchV1(requirement, available, input.context) ?? capabilityFailure(
      'capability.denied',
      input.descriptor.operation,
      input.resource.semanticResourceDigest
    )
  }
  if (!('anyOf' in capability)) {
    capabilityFailure('capability.denied', input.descriptor.operation, input.resource.semanticResourceDigest)
  }
  const requirement = templateRequirement(input, capability as OperationCapabilityRequirementTemplateV1)
  const names = [...new Set(requirement.anyOf.flatMap(branch => branch.allOf.map(ref => ref.name)))]
  const available = names.flatMap(name => {
    const value = materializeCapabilityConstraintsV1(input, name, true)
    return value == null ? [] : [{ constraints: value, name, version: 1 as const }]
  }) satisfies AvailableCapabilityV1[]
  return selectCapabilityBranchV1(requirement, available, input.context) ?? capabilityFailure(
    'capability.denied',
    input.descriptor.operation,
    input.resource.semanticResourceDigest
  )
}
