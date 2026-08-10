import { createResourceExhaustedError, createStdioWriteError, invalidArgument } from './errors.js'
import type { RuntimeNodeCoreError } from './errors.js'
import type { RuntimeStdioProvider } from './types.js'
import { utf8ByteLength } from './utf8.js'

const SafeUint8Array = Uint8Array
const typedArrayPrototype = Object.getPrototypeOf(SafeUint8Array.prototype)
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength'
)?.get
const intrinsicCall = Function.prototype.call.bind(Function.prototype.call) as (
  function_: (this: unknown, ...args: unknown[]) => unknown,
  thisArg: unknown,
  ...args: unknown[]
) => unknown

if (!typedArrayByteLengthGetter) {
  throw new Error('Uint8Array byteLength intrinsic is unavailable')
}

const getUint8ArrayByteLength = (value: Uint8Array): number => {
  return intrinsicCall(typedArrayByteLengthGetter, value) as number
}

export interface RuntimeWritable {
  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: string | ((error?: RuntimeNodeCoreError) => void),
    callback?: (error?: RuntimeNodeCoreError) => void
  ): boolean | Promise<boolean>
}

export const createRuntimeWritable = (
  stream: 'stderr' | 'stdout',
  provider: RuntimeStdioProvider,
  maxChunkBytes: number
): RuntimeWritable =>
  Object.freeze({
    write(
      chunk: string | Uint8Array,
      encodingOrCallback?: string | ((error?: RuntimeNodeCoreError) => void),
      callback?: (error?: RuntimeNodeCoreError) => void
    ) {
      if (typeof chunk !== 'string' && !(chunk instanceof SafeUint8Array)) {
        invalidArgument('chunk', 'process stdio accepts strings or Uint8Array values')
      }
      const chunkBytes = typeof chunk === 'string'
        ? utf8ByteLength(chunk)
        : getUint8ArrayByteLength(chunk)
      if (chunkBytes > maxChunkBytes) {
        throw createResourceExhaustedError(stream)
      }

      const done = typeof encodingOrCallback === 'function'
        ? encodingOrCallback
        : callback
      const admittedChunk = typeof chunk === 'string'
        ? chunk
        : new SafeUint8Array(chunk)
      const succeed = (result: boolean | void) => {
        done?.()
        return result !== false
      }
      const fail = (): never => {
        const error = createStdioWriteError(stream)
        done?.(error)
        throw error
      }
      let result: boolean | void | PromiseLike<boolean | void>
      let asynchronousResult: PromiseLike<boolean | void> | undefined
      try {
        result = provider.write(stream, admittedChunk)
        if (
          result != null &&
          typeof result === 'object' &&
          typeof result.then === 'function'
        ) {
          asynchronousResult = result
        }
      } catch {
        return fail()
      }
      return asynchronousResult === undefined
        ? succeed(result as boolean | void)
        : Promise.resolve(asynchronousResult).then(succeed, fail)
    }
  })
