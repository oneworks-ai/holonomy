import { intrinsics } from './intrinsics.js'

export type ChildProcessErrorCode =
  | 'child_process.cancelled'
  | 'child_process.invalid_argument'
  | 'child_process.limit_exceeded'
  | 'child_process.not_supported'
  | 'child_process.timeout'
  | 'child_process.internal'

const messages: Readonly<Record<ChildProcessErrorCode, string>> = Object.freeze({
  'child_process.cancelled': 'Child process operation was cancelled',
  'child_process.internal': 'Child process operation failed',
  'child_process.invalid_argument': 'Child process operation input is invalid',
  'child_process.limit_exceeded': 'Child process operation exceeded an authorized limit',
  'child_process.not_supported': 'Child process operation is not supported',
  'child_process.timeout': 'Child process operation timed out'
})

export class ChildProcessRuntimeError extends Error {
  readonly code: ChildProcessErrorCode

  constructor(code: ChildProcessErrorCode) {
    super(messages[code])
    this.code = code
    this.name = 'ChildProcessRuntimeError'
  }
}

const created = new WeakSet<ChildProcessRuntimeError>()

export const createChildProcessError = (code: ChildProcessErrorCode): ChildProcessRuntimeError => {
  const error = new ChildProcessRuntimeError(code)
  intrinsics.weakSetAdd(created, error)
  return error
}

export const isChildProcessError = (value: unknown): value is ChildProcessRuntimeError =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && intrinsics.weakSetHas(created, value)
