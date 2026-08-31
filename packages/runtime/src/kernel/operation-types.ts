export type InvocationModeV1 = 'callback' | 'promise' | 'sync'
export type OperationKindV1 = 'close' | 'invoke' | 'open' | 'read' | 'subscribe' | 'write'
export type InterceptionV1 = 'host' | 'systemOnly'

export interface OperationCapabilityRefV1 {
  readonly name: BuiltInCapabilityNameV1
  readonly version: 1
}

export interface OperationCapabilityBranchV1 {
  readonly allOf: readonly OperationCapabilityRefV1[]
  readonly branchId: string
}

export interface OperationCapabilityRequirementTemplateV1 {
  readonly anyOf: readonly OperationCapabilityBranchV1[]
}

export interface OperationResultVariantV1 {
  readonly resultSchemaId: string
  readonly whenArgumentsSchemaId: string
}

export type OperationCapabilityRequirementV1 =
  | OperationCapabilityRequirementTemplateV1
  | Readonly<{ kind: 'dynamic'; schemaId: string }>
  | Readonly<{ kind: 'inherited' }>
  | Readonly<{ kind: 'unavailable' }>

export type BuiltInCapabilityNameV1 =
  | 'host.device.sensitive'
  | 'host.device.state'
  | 'host.device.summary'
  | 'host.diagnostics.source.read'
  | 'host.fs'
  | 'host.network.http'
  | 'host.network.mock'
  | 'host.network.request-body.read'
  | 'host.process.execute'
  | 'host.process.network'
  | 'host.process.shell'
  | 'host.process.signal'
  | 'host.storage.credential'
  | 'host.system.basic'
  | 'host.system.compute'
  | 'host.system.identity'
  | 'host.system.memory'
  | 'host.system.network-topology'
  | 'host.system.process-identity'
  | 'host.system.runtime'
  | 'host.system.version'

export interface OperationDescriptorV1 {
  readonly argsSchemaId: string
  readonly capability: OperationCapabilityRequirementV1
  readonly deliverySchemaId: string
  readonly interception: InterceptionV1
  readonly kind: OperationKindV1
  readonly limitsOwner: string
  readonly member: string
  readonly module: string
  readonly modes: readonly InvocationModeV1[]
  readonly operation: string
  readonly resourceSchemaId: string
  readonly resultSchemaId: string
  readonly resultVariants?: readonly OperationResultVariantV1[]
}

const reference = (name: BuiltInCapabilityNameV1): OperationCapabilityRefV1 => Object.freeze({ name, version: 1 })

export const allOf = (
  branchId: string,
  ...names: readonly BuiltInCapabilityNameV1[]
): OperationCapabilityRequirementTemplateV1 =>
  Object.freeze({
    anyOf: Object.freeze([Object.freeze({
      allOf: Object.freeze(names.map(reference)),
      branchId
    })])
  })

export const anyOf = (
  ...branches: readonly (readonly [string, ...BuiltInCapabilityNameV1[]])[]
): OperationCapabilityRequirementTemplateV1 =>
  Object.freeze({
    anyOf: Object.freeze(branches.map(([branchId, ...names]) =>
      Object.freeze({
        allOf: Object.freeze(names.map(reference)),
        branchId
      })
    ))
  })

export const inheritedCapability = Object.freeze({ kind: 'inherited' as const })
export const unavailableCapability = Object.freeze({ kind: 'unavailable' as const })
export const dynamicCapability = (schemaId: string) =>
  Object.freeze({
    kind: 'dynamic' as const,
    schemaId
  })

export const operation = (value: OperationDescriptorV1): OperationDescriptorV1 => {
  const { resultVariants, ...rest } = value
  return Object.freeze({
    ...rest,
    modes: Object.freeze([...value.modes]),
    ...(resultVariants === undefined
      ? {}
      : { resultVariants: Object.freeze(resultVariants.map(item => Object.freeze({ ...item }))) })
  })
}
