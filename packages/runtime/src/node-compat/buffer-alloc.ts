import { encodeBufferString, normalizeEncoding } from './encoding.js'
import { invalidArgument } from './errors.js'

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get!
const fillBytes = Uint8Array.prototype.fill
const apply = Reflect.apply

export const assertAllocSize = (size: number): void => {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0 || size > Number.MAX_SAFE_INTEGER) {
    invalidArgument('size', 'Buffer size must be a finite non-negative safe number')
  }
}

// Numeric indexing and captured internal-slot probes avoid pattern species,
// iterators and overridden length/subarray accessors.
export const fillAllocBuffer = (
  target: Uint8Array,
  fill: unknown,
  encoding: unknown
): void => {
  const targetLength = apply(typedArrayLength, target, []) as number
  if (typeof fill === 'number') {
    apply(fillBytes, target, [fill & 0xFF])
    return
  }
  let pattern: Uint8Array
  let length: number
  if (typeof fill === 'string') {
    if (encoding !== undefined && encoding !== null && typeof encoding !== 'string') {
      invalidArgument('encoding')
    }
    const normalized = normalizeEncoding((encoding || undefined) as string | undefined)
    if (targetLength === 0 || fill.length === 0) return
    pattern = encodeBufferString(fill, normalized)
    length = apply(typedArrayLength, pattern, []) as number
  } else if (apply(typedArrayTag, fill, []) === 'Uint8Array') {
    pattern = fill as Uint8Array
    length = apply(typedArrayLength, pattern, []) as number
    if (targetLength === 0) return
  } else {
    return invalidArgument('fill', 'Buffer.alloc fill must be a number, string or Uint8Array')
  }
  if (length === 0) invalidArgument('fill', 'Buffer.alloc fill pattern must not be empty')
  for (let index = 0; index < targetLength; index += 1) {
    target[index] = pattern[index % length]!
  }
}
