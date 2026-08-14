import { CAPABILITY_ERROR_MAP_V1 } from './error-registry.js'
import type { HoloGuestErrorCodeV1, NodeGuestErrorCodeV1 } from './error-registry.js'
import { CapabilityInvocationError } from './errors.js'

export type GuestErrorFamilyV1 = 'childProcess' | 'holo' | 'nodeFs' | 'nodeSystem'

export class HoloGuestErrorV1 extends Error {
  readonly code: HoloGuestErrorCodeV1
  readonly operation: string
  readonly retryable: boolean

  constructor(code: HoloGuestErrorCodeV1, operation: string, retryable: boolean) {
    super(`${code}: Holonomy ${operation} failed`)
    this.name = 'HoloError'
    this.code = code
    this.operation = operation
    this.retryable = retryable
  }
}

export class NodeGuestErrorV1 extends Error {
  readonly code: NodeGuestErrorCodeV1
  readonly retryable: boolean

  constructor(code: NodeGuestErrorCodeV1, operation: string, retryable: boolean) {
    super(code === 'ABORT_ERR' ? 'The operation was aborted' : `${code}: Holonomy ${operation} failed`)
    this.name = code === 'ABORT_ERR'
      ? 'AbortError'
      : ['EINVAL', 'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_RETURN_VALUE'].includes(code)
      ? 'TypeError'
      : 'Error'
    this.code = code
    this.retryable = retryable
  }
}

export const translateCapabilityErrorV1 = (
  error: unknown,
  family: GuestErrorFamilyV1
): HoloGuestErrorV1 | NodeGuestErrorV1 => {
  const terminal = error instanceof CapabilityInvocationError
    ? error
    : new CapabilityInvocationError('provider.unavailable', 'unknown')
  const mapping = CAPABILITY_ERROR_MAP_V1[terminal.code]
  const code = family === 'childProcess'
    ? terminal.operation === 'process.stdin.write'
      ? mapping.childProcess.stdinWrite ?? mapping.childProcess.default
      : terminal.operation === 'process.program.spawn' || terminal.operation === 'process.shell.spawn'
      ? mapping.childProcess.capturedOutput ?? mapping.childProcess.default
      : mapping.childProcess.default
    : mapping[family]
  return family === 'holo'
    ? new HoloGuestErrorV1(code as HoloGuestErrorCodeV1, terminal.operation, terminal.retryable)
    : new NodeGuestErrorV1(code as NodeGuestErrorCodeV1, terminal.operation, terminal.retryable)
}
