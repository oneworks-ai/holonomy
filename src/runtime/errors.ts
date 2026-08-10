export type RuntimeComposerErrorCode =
  | 'runtime_composer.disposed'
  | 'runtime_composer.duplicate_module'
  | 'runtime_composer.invalid_options'
  | 'runtime_composer.principal_mismatch'
  | 'runtime_composer.required_capability'

export class RuntimeComposerError extends Error {
  constructor(readonly code: RuntimeComposerErrorCode) {
    super(code)
    this.name = 'RuntimeComposerError'
  }
}

const INTERNAL_ERRORS = new WeakSet<object>()
const REFLECT_APPLY = Reflect.apply
const WEAK_SET_ADD = WeakSet.prototype.add
const WEAK_SET_HAS = WeakSet.prototype.has

export const runtimeComposerError = (code: RuntimeComposerErrorCode) => {
  const error = new RuntimeComposerError(code)
  REFLECT_APPLY(WEAK_SET_ADD, INTERNAL_ERRORS, [error])
  return error
}

/** Only errors minted by this module may retain a composer code across a boundary. */
export const isRuntimeComposerError = (value: unknown): value is RuntimeComposerError =>
  value != null && typeof value === 'object' && REFLECT_APPLY(WEAK_SET_HAS, INTERNAL_ERRORS, [value])
