import { capabilityFailure } from './errors.js'
import { validateFiniteJsonSchemaV1 } from './finite-schema-validator.js'
import type { OperationDescriptorV1 } from './operation-types.js'
import { operationSchemaOwnerV1 } from './registry-schema-ids.js'

const validator = (schemaId: string): (value: unknown) => boolean => {
  const owner = operationSchemaOwnerV1(schemaId)
  if (owner == null) throw new Error(`Missing operation schema owner ${schemaId}`)
  return value => validateFiniteJsonSchemaV1(owner.schema, value)
}

export const validateBrokerArgumentsV1 = (
  descriptor: OperationDescriptorV1,
  value: unknown,
  semanticResourceDigest: string
): string | undefined => {
  if (!validator(descriptor.argsSchemaId)(value)) {
    capabilityFailure('argument.invalid', descriptor.operation, semanticResourceDigest)
  }
  const matches = descriptor.resultVariants?.filter(variant => validator(variant.whenArgumentsSchemaId)(value)) ?? []
  if (descriptor.resultVariants != null && matches.length !== 1) {
    capabilityFailure('argument.invalid', descriptor.operation, semanticResourceDigest)
  }
  return matches[0]?.resultSchemaId
}

export const validateBrokerResultV1 = (
  descriptor: OperationDescriptorV1,
  value: unknown,
  semanticResourceDigest: string,
  selectedResultSchemaId?: string
): void => {
  const schemaId = selectedResultSchemaId ?? descriptor.resultSchemaId
  if (!validator(schemaId)(value)) {
    capabilityFailure('result.invalid', descriptor.operation, semanticResourceDigest)
  }
}
