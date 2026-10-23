export class AssertionError extends Error {
  readonly actual: unknown
  readonly code = 'ERR_ASSERTION'
  readonly expected: unknown
  readonly operator: string

  constructor(message: string, actual?: unknown, expected?: unknown, operator = 'fail') {
    super(message)
    this.name = 'AssertionError'
    this.actual = actual
    this.expected = expected
    this.operator = operator
  }
}
