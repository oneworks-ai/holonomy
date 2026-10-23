import { describe, expect, it } from 'vitest'

import { createAssertStrictModule } from '../../../src/node-test/index.js'

const actualError = () => Object.assign(new TypeError('boom'), { code: 'EXPECTED', detail: { step: 'ready' } })
const throwing = () => {
  throw actualError()
}

describe('shared assert error validation', () => {
  it('matches object properties without silently accepting the wrong code', () => {
    const assert = createAssertStrictModule().default
    expect(assert.throws(throwing, { code: 'EXPECTED' })).toBeUndefined()
    expect(() => assert.throws(throwing, { code: 'WRONG' })).toThrowError(assert.AssertionError)
    expect(() => assert.throws(throwing, { absent: undefined })).toThrowError(assert.AssertionError)
    expect(() => assert.throws(throwing, { detail: { step: 'wrong' } })).toThrowError(assert.AssertionError)
    assert.throws(throwing, { detail: { step: 'ready' }, message: /boo/, code: /^EXP/ })
  })

  it('validates asynchronous rejection and resolves only undefined on success', async () => {
    const assert = createAssertStrictModule().default
    expect(await assert.rejects(Promise.reject(actualError()), { code: 'EXPECTED' })).toBeUndefined()
    await expect(assert.rejects(async () => {
      throw actualError()
    }, { code: 'WRONG' })).rejects.toBeInstanceOf(assert.AssertionError)
    await expect(assert.rejects(Promise.resolve(1))).rejects.toBeInstanceOf(assert.AssertionError)
  })

  it('requires validator literal true, and supports constructors and Error instances', async () => {
    const assert = createAssertStrictModule().default
    assert.throws(throwing, TypeError)
    assert.throws(throwing, new TypeError('boom'))
    expect(() => assert.throws(throwing, RangeError)).toThrowError(assert.AssertionError)
    expect(() => assert.throws(throwing, new TypeError('other'))).toThrowError(assert.AssertionError)
    assert.throws(throwing, error => error instanceof TypeError)
    for (const result of [1, 'yes', false, undefined]) {
      expect(() => assert.throws(throwing, () => result)).toThrowError(assert.AssertionError)
      await expect(assert.rejects(Promise.reject(actualError()), () => result)).rejects.toBeInstanceOf(
        assert.AssertionError
      )
    }
  })

  it('matches whole thrown-error text for a RegExp and rejects an empty object', () => {
    const assert = createAssertStrictModule().default
    assert.throws(throwing, /^TypeError: boom$/)
    expect(() => assert.throws(throwing, /^boom$/)).toThrowError(assert.AssertionError)
    expect(() => assert.throws(throwing, {})).toThrowError(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }))
  })

  it('does not count argument errors or synchronous Promise factory throws as expected errors', async () => {
    const assert = createAssertStrictModule().default
    expect(() => assert.throws(null as unknown as () => unknown)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    )
    const original = actualError()
    await expect(assert.rejects(() => {
      throw original
    }, { code: 'WRONG' })).rejects.toBe(original)
    await expect(assert.rejects(() => 1 as unknown as Promise<unknown>)).rejects.toMatchObject({
      code: 'ERR_INVALID_RETURN_VALUE'
    })
  })

  it('accepts null or a message overload without treating a string as an error pattern', async () => {
    const assert = createAssertStrictModule().default
    assert.throws(throwing, null)
    assert.throws(throwing, 'custom message')
    expect(() => assert.throws(throwing, 'boom')).toThrowError(
      expect.objectContaining({ code: 'ERR_AMBIGUOUS_ARGUMENT' })
    )
    expect(() => assert.throws(() => {}, 'custom message')).toThrowError('custom message')
    expect(await assert.rejects(Promise.reject(actualError()), null)).toBeUndefined()
    expect(await assert.rejects(Promise.reject(actualError()), 'custom message')).toBeUndefined()
  })

  it('does not equate different internal values of Date, RegExp, Map, Set or buffers', () => {
    const assert = createAssertStrictModule().default
    const a = new Uint8Array([1]).buffer
    const b = new Uint8Array([2]).buffer
    const av = new DataView(a)
    const bv = new DataView(b)
    Object.defineProperty(av, 'byteLength', { value: 0 })
    Object.defineProperty(bv, 'byteLength', { value: 0 })
    for (
      const [actual, expected] of [
        [new Date(0), new Date(1)],
        [/actual/g, /expected/g],
        [new Map([['a', 1]]), new Map([['a', 2]])],
        [new Set([1]), new Set([2])],
        [a, b],
        [av, bv],
        [new Object(1), new Object(2)]
      ]
    ) {
      expect(() =>
        assert.throws(() => {
          throw Object.assign(new Error('actual'), { detail: actual })
        }, { detail: expected })
      ).toThrowError(assert.AssertionError)
      expect(() => assert.deepStrictEqual(actual, expected)).toThrowError(assert.AssertionError)
    }
  })

  it('compares unordered deep collection members and cycles without requiring insertion order', () => {
    const assert = createAssertStrictModule().default
    assert.deepStrictEqual(new Map([[{ id: 1 }, 'a'], [{ id: 2 }, 'b']]), new Map([[{ id: 2 }, 'b'], [{ id: 1 }, 'a']]))
    assert.deepStrictEqual(new Set([{ id: 1 }, { id: 2 }]), new Set([{ id: 2 }, { id: 1 }]))
    const a = new Map()
    const b = new Map()
    a.set(a, a)
    b.set(b, b)
    assert.deepStrictEqual(a, b)
    assert.deepStrictEqual(new Error('same'), new Error('same'))
  })

  it('rejects plain thenables and forged Promise prototypes without invoking their then property', async () => {
    const assert = createAssertStrictModule().default
    let calls = 0
    for (const prototype of [Object.prototype, Promise.prototype]) {
      const value = Object.create(prototype, {
        then: {
          get() {
            calls++
            return (_resolve: unknown, reject: (error: Error) => void) => reject(new Error('boom'))
          }
        }
      })
      await expect(assert.rejects(value)).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' })
      await expect(assert.rejects(() => value)).rejects.toMatchObject({ code: 'ERR_INVALID_RETURN_VALUE' })
    }
    expect(calls).toBe(0)
  })
})
