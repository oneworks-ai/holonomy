import { resolveArrayBufferViewRange } from './buffer-arraybuffer.js'
import { base64ByteLength, decodeBufferBytes, encodeBufferString, normalizeEncoding } from './encoding.js'
import type { BufferEncoding } from './encoding.js'
import { invalidArgument } from './errors.js'

export type RuntimeBufferInput =
  | ArrayBuffer
  | ArrayLike<number>
  | RuntimeBuffer
  | Uint8Array
  | string

const assertSize = (size: number): void => {
  if (!Number.isSafeInteger(size) || size < 0) {
    invalidArgument('size', 'Buffer size must be a non-negative safe integer')
  }
}

const copyBytes = (bytes: Uint8Array): RuntimeBuffer => {
  const result = new RuntimeBuffer(bytes.byteLength)
  result.set(bytes)
  return result
}

const normalizeStringIndex = (
  value: number | undefined,
  fallback: number,
  maximum: number
): number => {
  if (value === undefined) return fallback
  if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return 0
  if (value === Number.POSITIVE_INFINITY) return maximum
  return Math.min(Math.max(Math.trunc(value), 0), maximum)
}

export class RuntimeBuffer extends Uint8Array {
  constructor(length: number)
  constructor(buffer: ArrayBuffer, byteOffset?: number, length?: number)
  constructor(
    input: ArrayBuffer | number,
    byteOffset?: number,
    length?: number
  ) {
    if (typeof input === 'number') {
      super(input)
    } else {
      super(input, byteOffset, length)
    }
  }

  equals(otherBuffer: Uint8Array): boolean {
    if (!(otherBuffer instanceof Uint8Array)) {
      invalidArgument('otherBuffer', 'Buffer.equals expects a Uint8Array')
    }
    return this.length === otherBuffer.length &&
      this.every((byte, index) => byte === otherBuffer[index])
  }

  override slice(start?: number, end?: number): RuntimeBuffer {
    return this.subarray(start, end)
  }

  override subarray(begin?: number, end?: number): RuntimeBuffer {
    return super.subarray(begin, end) as RuntimeBuffer
  }

  toString(encoding?: BufferEncoding | 'utf-8', start = 0, end = this.length): string {
    const boundedStart = normalizeStringIndex(start, 0, this.length)
    const boundedEnd = normalizeStringIndex(end, this.length, this.length)
    return decodeBufferBytes(this.subarray(boundedStart, boundedEnd), encoding)
  }
}

export interface RuntimeBufferConstructor {
  readonly prototype: RuntimeBuffer
  alloc(size: number): RuntimeBuffer
  allocUnsafe(size: number): RuntimeBuffer
  byteLength(value: string | ArrayBuffer | Uint8Array, encoding?: string): number
  concat(list: readonly Uint8Array[], totalLength?: number): RuntimeBuffer
  from(arrayBuffer: ArrayBuffer, byteOffset?: number, length?: number): RuntimeBuffer
  from(value: ArrayLike<number> | RuntimeBuffer | Uint8Array | string, encoding?: string): RuntimeBuffer
  isBuffer(value: unknown): value is RuntimeBuffer
}

function from(arrayBuffer: ArrayBuffer, byteOffset?: number, length?: number): RuntimeBuffer
function from(
  value: ArrayLike<number> | RuntimeBuffer | Uint8Array | string,
  encoding?: string
): RuntimeBuffer
function from(
  value: RuntimeBufferInput,
  encodingOrOffset?: number | string,
  length?: number
): RuntimeBuffer {
  if (typeof value === 'string') {
    return copyBytes(encodeBufferString(value, encodingOrOffset as string | undefined))
  }
  if (value instanceof ArrayBuffer) {
    const range = resolveArrayBufferViewRange(
      value.byteLength,
      encodingOrOffset as number | undefined,
      length
    )
    return new RuntimeBuffer(value, range.offset, range.length)
  }
  if (value instanceof Uint8Array) {
    return copyBytes(value)
  }
  if (typeof value === 'object' && value !== null && 'length' in value) {
    return copyBytes(Uint8Array.from(value as ArrayLike<number>))
  }
  return invalidArgument('value', 'Buffer.from received an unsupported value')
}

const byteLength = (
  value: string | ArrayBuffer | Uint8Array,
  encoding?: string
): number => {
  if (typeof value === 'string') {
    switch (normalizeEncoding(encoding)) {
      case 'base64':
      case 'base64url':
        return base64ByteLength(value)
      case 'hex':
        return Math.floor(value.length / 2)
      case 'utf8':
        return encodeBufferString(value, encoding).byteLength
    }
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return value.byteLength
  }
  return invalidArgument('value', 'Buffer.byteLength received an unsupported value')
}

const concat = (
  list: readonly Uint8Array[],
  totalLength?: number
): RuntimeBuffer => {
  if (!Array.isArray(list) || list.some(item => !(item instanceof Uint8Array))) {
    invalidArgument('list', 'Buffer.concat expects Uint8Array values')
  }
  const length = totalLength ??
    list.reduce((sum, item) => sum + item.byteLength, 0)
  assertSize(length)
  const result = new RuntimeBuffer(length)
  let offset = 0
  for (const item of list) {
    if (offset >= length) {
      break
    }
    const writable = Math.min(item.byteLength, length - offset)
    result.set(item.subarray(0, writable), offset)
    offset += writable
  }
  return result
}

export const Buffer = RuntimeBuffer as unknown as RuntimeBufferConstructor

Object.defineProperties(Buffer, {
  alloc: {
    value: (size: number) => {
      assertSize(size)
      return new RuntimeBuffer(size)
    }
  },
  allocUnsafe: {
    value: (size: number) => {
      assertSize(size)
      return new RuntimeBuffer(size)
    }
  },
  byteLength: { value: byteLength },
  concat: { value: concat },
  from: { value: from },
  isBuffer: { value: (value: unknown) => value instanceof RuntimeBuffer }
})

export interface BufferSyntheticModule {
  readonly Buffer: RuntimeBufferConstructor
  readonly default: Readonly<{ Buffer: RuntimeBufferConstructor }>
}

export const createBufferSyntheticModule = (): BufferSyntheticModule => {
  return Object.freeze({ Buffer, default: Object.freeze({ Buffer }) })
}
