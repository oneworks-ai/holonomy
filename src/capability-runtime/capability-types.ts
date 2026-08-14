import type { JsonValueV1 } from './json-types.js'
import type { BuiltInCapabilityNameV1 } from './operation-types.js'

export interface CapabilityRefV1 {
  readonly constraints: Readonly<Record<string, JsonValueV1>>
  readonly name: BuiltInCapabilityNameV1
  readonly version: 1
}

export interface CapabilityBranchV1 {
  readonly allOf: readonly CapabilityRefV1[]
  readonly branchId: string
}

export interface CapabilityRequirementV1 {
  readonly anyOf: readonly CapabilityBranchV1[]
}

export interface CapabilityBindingV1 {
  readonly branchId: string
  readonly constraints: Readonly<Record<string, JsonValueV1>>
  readonly digest: string
  readonly name: BuiltInCapabilityNameV1
  readonly source: 'policy'
  readonly version: 1
}

export interface AuthorityBindingV1 {
  readonly authorityDigest: string
  readonly authorityVersion: 1
  readonly capabilityName: BuiltInCapabilityNameV1
  readonly constraints: Readonly<Record<string, JsonValueV1>>
  readonly providerModule: string
}

export interface CapabilitySelectionV1 {
  readonly authorityBindings: readonly AuthorityBindingV1[]
  readonly bindings: readonly CapabilityBindingV1[]
  readonly branchId: string
  readonly requirement: CapabilityRequirementV1
}

export type CapabilityConstraintKindV1 =
  | 'credential'
  | 'device'
  | 'empty'
  | 'filesystem'
  | 'network'
  | 'numericReader'
  | 'process'
  | 'system'

export interface CapabilityDefinitionDescriptorV1 {
  readonly constraintKind: CapabilityConstraintKindV1
  readonly constraintSchemaId: string
  readonly name: BuiltInCapabilityNameV1
  readonly providerModule: string
  readonly version: 1
}
