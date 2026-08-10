import {
  RuntimeReadableStream,
  RuntimeReadableStreamDefaultController,
  RuntimeReadableStreamDefaultReader
} from './web-readable.js'
import { RuntimeTransformStream, RuntimeTransformStreamDefaultController } from './web-transform.js'
import {
  RuntimeWritableStream,
  RuntimeWritableStreamDefaultController,
  RuntimeWritableStreamDefaultWriter
} from './web-writable.js'

export * from './web-readable.js'
export * from './web-strategy.js'
export * from './web-transform.js'
export * from './web-writable.js'

export const ReadableStream = RuntimeReadableStream
export const ReadableStreamDefaultController = RuntimeReadableStreamDefaultController
export const ReadableStreamDefaultReader = RuntimeReadableStreamDefaultReader
export const TransformStream = RuntimeTransformStream
export const TransformStreamDefaultController = RuntimeTransformStreamDefaultController
export const WritableStream = RuntimeWritableStream
export const WritableStreamDefaultController = RuntimeWritableStreamDefaultController
export const WritableStreamDefaultWriter = RuntimeWritableStreamDefaultWriter

export const createWebStreamsGlobals = () =>
  Object.freeze({
    ReadableStream,
    TransformStream,
    WritableStream
  })
