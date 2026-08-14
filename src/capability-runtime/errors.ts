import type { InternalCapabilityCodeV1 } from './error-registry.js'

export type CapabilityContractErrorCode =
  | 'runtime.binding_unavailable'
  | 'runtime.configuration_invalid'
  | 'runtime.policy_version_unsupported'

export class CapabilityContractError extends Error {
  readonly code: CapabilityContractErrorCode

  constructor(code: CapabilityContractErrorCode) {
    super(
      code === 'runtime.policy_version_unsupported'
        ? 'Unsupported Holonomy sandbox policy version'
        : code === 'runtime.binding_unavailable'
        ? 'Required Holonomy host binding is unavailable'
        : 'Invalid Holonomy capability configuration'
    )
    this.name = 'CapabilityContractError'
    this.code = code
  }
}

export const invalidPolicy = (): never => {
  throw new CapabilityContractError('runtime.configuration_invalid')
}

export const bindingUnavailable = (): never => {
  throw new CapabilityContractError('runtime.binding_unavailable')
}

export interface InternalCapabilityErrorSnapshotV1 {
  readonly code: InternalCapabilityCodeV1
  readonly operation: string
  readonly retryable: boolean
  readonly semanticResourceDigest?: string
  readonly terminal: true
}

const RETRYABLE_INTERNAL_CODES = new Set<InternalCapabilityCodeV1>([
  'middleware.timeout',
  'provider.connection_refused',
  'provider.timeout',
  'provider.unavailable'
])

export class CapabilityInvocationError extends Error implements InternalCapabilityErrorSnapshotV1 {
  readonly code: InternalCapabilityCodeV1
  readonly operation: string
  readonly retryable: boolean
  readonly semanticResourceDigest?: string
  readonly terminal = true as const

  constructor(
    code: InternalCapabilityCodeV1,
    operation: string,
    semanticResourceDigest?: string
  ) {
    super(`Holonomy capability invocation failed: ${code}`)
    this.name = 'CapabilityInvocationError'
    this.code = code
    this.operation = operation
    this.retryable = RETRYABLE_INTERNAL_CODES.has(code)
    if (semanticResourceDigest !== undefined) this.semanticResourceDigest = semanticResourceDigest
  }
}

export const capabilityFailure = (
  code: InternalCapabilityCodeV1,
  operation: string,
  semanticResourceDigest?: string
): never => {
  throw new CapabilityInvocationError(code, operation, semanticResourceDigest)
}
