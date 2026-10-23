import { deepEqualValue } from './assert-deep-value.js'
import { invalidAssertionArgument, matchExpectedException } from './assert-error-matcher.js'
import type { ExpectedException } from './assert-error-matcher.js'
import { AssertionError } from './assertion-error.js'
import { assignTestProperties, freezeTestValue, isTestValue } from './intrinsics.js'

export { AssertionError } from './assertion-error.js'

const fail = (message = 'Failed') => {
  throw new AssertionError(message)
}

const strictEqual = (actual: unknown, expected: unknown, message?: string) => {
  if (!isTestValue(actual, expected)) {
    throw new AssertionError(message ?? 'Expected values to be strictly equal', actual, expected, 'strictEqual')
  }
}

const deepStrictEqual = (actual: unknown, expected: unknown, message?: string) => {
  if (!deepEqualValue(actual, expected)) {
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

const equalErrorProperty = deepEqualValue

const throws = (callback: () => unknown, expected?: ExpectedException, message?: string): void => {
  if (typeof callback !== 'function') invalidAssertionArgument('ERR_INVALID_ARG_TYPE')
  try {
    callback()
  } catch (error) {
    matchExpectedException(error, expected, equalErrorProperty, 'throws', message)
    return
  }
  fail(message ?? (typeof expected === 'string' ? expected : 'Expected function to throw'))
}

const promiseThen = Promise.prototype.then
const isPromise = (value: unknown): boolean => {
  try {
    promiseThen.call(value as Promise<unknown>, () => undefined, () => undefined)
    return true
  } catch {
    return false
  }
}

const rejects = async (
  value: PromiseLike<unknown> | (() => PromiseLike<unknown>),
  expected?: ExpectedException,
  message?: string,
  promiseBrand: (value: unknown) => boolean = isPromise
): Promise<void> => {
  // A synchronous throw while obtaining the Promise is not its rejection.
  const pending = typeof value === 'function' ? value() : value
  if (promiseBrand(pending) !== true) {
    invalidAssertionArgument(typeof value === 'function' ? 'ERR_INVALID_RETURN_VALUE' : 'ERR_INVALID_ARG_TYPE')
  }
  try {
    await pending
  } catch (error) {
    matchExpectedException(error, expected, equalErrorProperty, 'rejects', message)
    return
  }
  fail(message ?? (typeof expected === 'string' ? expected : 'Expected promise to reject'))
}

export const createAssertStrictModule = (promiseBrand: (value: unknown) => boolean = isPromise) => {
  const assertFunction = (value: unknown, message?: string) => ok(value, message)
  const assert = assignTestProperties(assertFunction, {
    AssertionError,
    deepEqual: deepStrictEqual,
    deepStrictEqual,
    equal: strictEqual,
    fail,
    match,
    notDeepEqual(actual: unknown, expected: unknown, message?: string) {
      if (deepEqualValue(actual, expected)) {
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
    rejects: (
      value: PromiseLike<unknown> | (() => PromiseLike<unknown>),
      expected?: ExpectedException,
      message?: string
    ) => rejects(value, expected, message, promiseBrand),
    strictEqual,
    throws
  })
  return freezeTestValue({ ...assert, default: freezeTestValue(assert) })
}
