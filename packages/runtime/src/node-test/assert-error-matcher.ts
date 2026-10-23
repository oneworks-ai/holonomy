import { AssertionError } from './assertion-error.js'
import { defineTestProperty, getTestEnumerableKeys, testString } from './intrinsics.js'

export type ExpectedException =
  | null
  | string
  | RegExp
  | Error
  | Readonly<Record<string, unknown>>
  | ((error: unknown) => unknown)
  | (abstract new(...args: never[]) => unknown)

const NativeError = Error
const NativeRegExp = RegExp
const NativeTypeError = TypeError
const regexpTest = RegExp.prototype.test

export const invalidAssertionArgument = (
  code: 'ERR_INVALID_ARG_TYPE' | 'ERR_INVALID_ARG_VALUE' | 'ERR_INVALID_RETURN_VALUE' | 'ERR_AMBIGUOUS_ARGUMENT'
): never => {
  const error = new NativeTypeError('Invalid assertion argument')
  defineTestProperty(error, 'code', { configurable: true, enumerable: true, value: code, writable: true })
  throw error
}

export const matchExpectedException = (
  error: unknown,
  expected: ExpectedException | undefined,
  equal: (actual: unknown, expected: unknown) => boolean,
  operator: 'throws' | 'rejects',
  message?: string
): void => {
  const mismatch = (): never => {
    throw new AssertionError(message ?? 'Error did not match the expected validation', error, expected, operator)
  }
  if (expected == null) return
  if (typeof expected === 'string') {
    if (
      message === undefined && (testString(error) === expected ||
        error != null && typeof error === 'object' && (error as { message?: unknown }).message === expected)
    ) {
      invalidAssertionArgument('ERR_AMBIGUOUS_ARGUMENT')
    }
    return
  }
  if (expected instanceof NativeRegExp) {
    if (!regexpTest.call(expected, testString(error))) mismatch()
    return
  }
  if (typeof expected === 'function') {
    const prototype = expected.prototype
    if (prototype != null && error instanceof expected) return
    if (expected === NativeError || prototype instanceof NativeError) mismatch()
    if ((expected as (error: unknown) => unknown)(error) !== true) mismatch()
    return
  }
  if (expected === null || typeof expected !== 'object') invalidAssertionArgument('ERR_INVALID_ARG_TYPE')
  const keys = getTestEnumerableKeys(expected)
  if (expected instanceof NativeError) {
    if (!keys.includes('name')) keys.push('name')
    if (!keys.includes('message')) keys.push('message')
  } else if (keys.length === 0) invalidAssertionArgument('ERR_INVALID_ARG_VALUE')
  if (error == null || typeof error !== 'object' && typeof error !== 'function') mismatch()
  const actual = error as Record<string, unknown>
  const wanted = expected as unknown as Record<string, unknown>
  for (const key of keys) {
    if (!(key in actual)) mismatch()
    const value = actual[key]
    const target = wanted[key]
    if (target instanceof NativeRegExp && typeof value === 'string') {
      if (!regexpTest.call(target, value)) mismatch()
    } else if (!equal(value, target)) mismatch()
  }
}
