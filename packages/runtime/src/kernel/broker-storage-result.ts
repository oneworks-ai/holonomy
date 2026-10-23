import { validateStorageResultPolicyV1 } from '@holonomyjs/capability-storage/kernel/storage-result-validation'
import type { StorageOperationV1 } from '@holonomyjs/capability-storage/kernel/storage-types'
import { validateBrokerResultV1 } from './broker-validation.js'
import type { TrustedInvocationValueV1 } from './broker-values.js'
import type { OperationDescriptorV1 } from './operation-types.js'
import type { SandboxPolicyV2 } from './sandbox-policy.js'

export const createBrokerResultValidatorV1 = (
  descriptor: OperationDescriptorV1,
  providerModule: string,
  args: unknown,
  policy: SandboxPolicyV2,
  semanticResourceDigest: string,
  resultSchemaId?: string
) =>
(result: TrustedInvocationValueV1): void => {
  validateBrokerResultV1(descriptor, result.value, semanticResourceDigest, resultSchemaId)
  if (providerModule === 'host.storage' && policy.storage.access === 'sandboxed') {
    validateStorageResultPolicyV1(
      descriptor.operation as StorageOperationV1,
      result.value,
      args,
      policy.storage.limits,
      semanticResourceDigest
    )
  }
}
