import { canonicalJson } from './canonical-json.js'
import { OPERATION_REGISTRY_V1 } from './operation-registry.js'

const capabilityLabel = (value: (typeof OPERATION_REGISTRY_V1)[number]['capability']): string => {
  if ('kind' in value) return value.kind === 'dynamic' ? `dynamic:${value.schemaId}` : value.kind
  return value.anyOf.map(branch => branch.allOf.map(item => item.name).join('+')).join(' OR ')
}

export const operationRegistryJsonV1 = (): string =>
  canonicalJson(
    OPERATION_REGISTRY_V1 as unknown as import('./canonical-json.js').CanonicalJsonValue
  )

export const operationRegistryMarkdownV1 = (): string => {
  const header =
    '| Module | Member | Mode | Operation | Layer | Capability | Args | Result | Result variants | Delivery | Resource | Limits |\n' +
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  const rows = OPERATION_REGISTRY_V1.map(value =>
    `| ${value.module} | ${value.member} | ${
      value.modes.join('+') || 'events'
    } | ${value.operation} | ${value.interception} | ${
      capabilityLabel(value.capability)
    } | ${value.argsSchemaId} | ${value.resultSchemaId} | ${
      value.resultVariants?.map(item => `${item.whenArgumentsSchemaId}→${item.resultSchemaId}`).join('<br>') ?? '-'
    } | ${value.deliverySchemaId} | ${value.resourceSchemaId} | ${value.limitsOwner} |`
  )
  return `${header}\n${rows.join('\n')}\n`
}
