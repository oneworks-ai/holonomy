import { types } from 'node:util'

const prototype = Object.getPrototypeOf(Uint8Array.prototype)
const getter = name => Object.getOwnPropertyDescriptor(prototype, name).get
const buffer = getter('buffer')
const byteLength = getter('byteLength')
const byteOffset = getter('byteOffset')
const tag = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag).get
const backingLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
const set = prototype.set

// Never consult foreign properties, iterators, species or constructors. The
// internal-slot probes also reject DataView, SharedArrayBuffer and Proxies.
export function copyNodeCryptoBytes(value, maximum) {
  if (types.isProxy(value) || Reflect.apply(tag, value, []) !== 'Uint8Array') {
    throw new TypeError('Invalid crypto bytes')
  }
  const backing = Reflect.apply(buffer, value, [])
  const length = Reflect.apply(byteLength, value, [])
  const offset = Reflect.apply(byteOffset, value, [])
  const capacity = Reflect.apply(backingLength, backing, [])
  if (
    !Number.isSafeInteger(length) || length > maximum || offset + length > capacity ||
    (resizable != null && Reflect.apply(resizable, backing, []))
  ) throw new TypeError('Invalid crypto bytes')
  const source = new Uint8Array(backing, offset, length)
  const owned = new Uint8Array(length)
  Reflect.apply(set, owned, [source])
  return owned
}
