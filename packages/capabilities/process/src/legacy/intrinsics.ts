const descriptor = Object.getOwnPropertyDescriptor
const symbols = Object.getOwnPropertySymbols
const prototype = Object.getPrototypeOf
const keys = Object.keys
const freeze = Object.freeze
const apply = Reflect.apply
const then = Promise.prototype.then
const resolve = Promise.resolve.bind(Promise)
const charCodeAt = String.prototype.charCodeAt
const hasOwn = Object.hasOwn
const weakSetAdd = WeakSet.prototype.add
const weakSetHas = WeakSet.prototype.has
const arrayIndexOf = Array.prototype.indexOf
const arrayPush = Array.prototype.push
const safeInteger = Number.isSafeInteger
const minimum = Math.min
const setTimer = descriptor(globalThis, 'setTimeout')
const clearTimer = descriptor(globalThis, 'clearTimeout')
const abortSignal = descriptor(globalThis, 'AbortSignal')
const eventTarget = descriptor(globalThis, 'EventTarget')
const abortPrototype = abortSignal && 'value' in abortSignal && typeof abortSignal.value === 'function'
  ? abortSignal.value.prototype
  : undefined
const eventPrototype = eventTarget && 'value' in eventTarget && typeof eventTarget.value === 'function'
  ? eventTarget.value.prototype
  : undefined
const aborted = abortPrototype ? descriptor(abortPrototype, 'aborted')?.get : undefined
const addEventListener = eventPrototype ? descriptor(eventPrototype, 'addEventListener')?.value : undefined
const removeEventListener = eventPrototype ? descriptor(eventPrototype, 'removeEventListener')?.value : undefined

export const intrinsics = freeze({
  arrayIsArray: Array.isArray,
  arrayPrototype: Array.prototype,
  arrayIndexOf: (values: readonly unknown[], value: unknown) => apply(arrayIndexOf, values, [value]) as number,
  arrayPush: (values: unknown[], value: unknown) => apply(arrayPush, values, [value]) as number,
  apply: (fn: Function, receiver: unknown, args: ArrayLike<unknown>) => apply(fn, receiver, args),
  charCodeAt: (value: string, index: number) => apply(charCodeAt, value, [index]) as number,
  clearTimeout: clearTimer && 'value' in clearTimer && typeof clearTimer.value === 'function'
    ? clearTimer.value as (id: unknown) => void
    : undefined,
  create: Object.create,
  descriptor,
  hasOwn,
  freeze,
  keys,
  min: minimum,
  promiseThen: (promise: Promise<unknown>, fulfilled: (value: unknown) => void, rejected: (reason: unknown) => void) =>
    apply(then, promise, [fulfilled, rejected]),
  resolve,
  setTimeout: setTimer && 'value' in setTimer && typeof setTimer.value === 'function'
    ? setTimer.value as (fn: () => void, ms: number) => unknown
    : undefined,
  symbols,
  objectPrototype: Object.prototype,
  prototype,
  safeInteger,
  weakSetAdd: (set: WeakSet<object>, value: object) => apply(weakSetAdd, set, [value]),
  weakSetHas: (set: WeakSet<object>, value: object) => apply(weakSetHas, set, [value]),
  abort:
    typeof aborted === 'function' && typeof addEventListener === 'function' && typeof removeEventListener === 'function'
      ? freeze({ aborted, addEventListener, removeEventListener })
      : undefined
})
