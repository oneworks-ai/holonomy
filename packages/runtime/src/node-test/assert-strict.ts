import {
  assignTestProperties,
  freezeTestValue,
  getTestOwnDescriptor,
  getTestPrototype,
  isTestValue,
  ownTestKeys,
  testString
} from './intrinsics.js'

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

const fail = (message = 'Failed') => {
  throw new AssertionError(message)
}

const deepEqualValue = (actual: unknown, expected: unknown, seen: WeakMap<object, object>): boolean => {
  if (isTestValue(actual, expected)) return true
  if (actual == null || expected == null || typeof actual !== 'object' || typeof expected !== 'object') return false
  if (getTestPrototype(actual) !== getTestPrototype(expected)) return false
  if (seen.get(actual) === expected) return true
  seen.set(actual, expected)
  const actualKeys = ownTestKeys(actual)
  const expectedKeys = ownTestKeys(expected)
  if (actualKeys.length !== expectedKeys.length) return false
  for (let index = 0; index < actualKeys.length; index += 1) {
    const key = actualKeys[index]!
    let found = false
    for (let expectedIndex = 0; expectedIndex < expectedKeys.length; expectedIndex += 1) {
      if (isTestValue(expectedKeys[expectedIndex], key)) found = true
    }
    if (!found) return false
    const actualDescriptor = getTestOwnDescriptor(actual, key)
    const expectedDescriptor = getTestOwnDescriptor(expected, key)
    if (
      actualDescriptor == null ||
      expectedDescriptor == null ||
      !('value' in actualDescriptor) ||
      !('value' in expectedDescriptor) ||
      !deepEqualValue(actualDescriptor.value, expectedDescriptor.value, seen)
    ) return false
  }
  return true
}

const strictEqual = (actual: unknown, expected: unknown, message?: string) => {
  if (!isTestValue(actual, expected)) {
    throw new AssertionError(message ?? 'Expected values to be strictly equal', actual, expected, 'strictEqual')
  }
}

const deepStrictEqual = (actual: unknown, expected: unknown, message?: string) => {
  if (!deepEqualValue(actual, expected, new WeakMap())) {
    throw new AssertionError(message ?? 'Expected values to be deeply equal', actual, expected, 'deepStrictEqual')
  }
}

const ok = (value: unknown, message?: string) => {
  if (!value) throw new AssertionError(message ?? 'Expected value to be truthy', value, true, 'ok')
}

const match = (value: string, expression: RegExp, message?: string) => {
  if (typeof value !== 'string' || !(expression instanceof RegExp) || !expression.test(value)) {
    throw new AssertionError(message ?? 'Expected string to match expression', value, expression, 'match')
  }
}

const throws = (callback: () => unknown, expected?: RegExp | ((error: unknown) => boolean)) => {
  try {
    callback()
  } catch (error) {
    if (expected instanceof RegExp) match(testString((error as { message?: unknown })?.message ?? error), expected)
    else if (typeof expected === 'function' && !expected(error)) fail('Thrown error did not satisfy validator')
    return error
  }
  fail('Expected function to throw')
}

const rejects = async (
  value: PromiseLike<unknown> | (() => PromiseLike<unknown>),
  expected?: RegExp | ((error: unknown) => boolean)
) => {
  try {
    await (typeof value === 'function' ? value() : value)
  } catch (error) {
    if (expected instanceof RegExp) match(testString((error as { message?: unknown })?.message ?? error), expected)
    else if (typeof expected === 'function' && !expected(error)) fail('Rejected error did not satisfy validator')
    return error
  }
  fail('Expected promise to reject')
}

export const createAssertStrictModule = () => {
  const assertFunction = (value: unknown, message?: string) => ok(value, message)
  const assert = assignTestProperties(assertFunction, {
    AssertionError,
    deepEqual: deepStrictEqual,
    deepStrictEqual,
    equal: strictEqual,
    fail,
    match,
    notDeepEqual(actual: unknown, expected: unknown, message?: string) {
      if (deepEqualValue(actual, expected, new WeakMap())) {
        throw new AssertionError(message ?? 'Expected values not to be deeply equal', actual, expected, 'notDeepEqual')
      }
    },
    notEqual(actual: unknown, expected: unknown, message?: string) {
      if (isTestValue(actual, expected)) {
        throw new AssertionError(message ?? 'Expected values not to be strictly equal', actual, expected, 'notEqual')
      }
    },
    notStrictEqual(actual: unknown, expected: unknown, message?: string) {
      if (isTestValue(actual, expected)) {
        throw new AssertionError(
          message ?? 'Expected values not to be strictly equal',
          actual,
          expected,
          'notStrictEqual'
        )
      }
    },
    ok,
    rejects,
    strictEqual,
    throws
  })
  return freezeTestValue({ ...assert, default: freezeTestValue(assert) })
}
