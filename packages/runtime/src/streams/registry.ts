import type { StreamModuleSpecifier } from './capabilities.js'
import {
  Duplex,
  PassThrough,
  Readable,
  Stream,
  Transform,
  Writable,
  finished,
  finishedPromise,
  pipeline,
  pipelinePromise
} from './node-streams.js'
import {
  ReadableStream,
  ReadableStreamDefaultController,
  ReadableStreamDefaultReader,
  TransformStream,
  TransformStreamDefaultController,
  WritableStream,
  WritableStreamDefaultController,
  WritableStreamDefaultWriter
} from './web-streams.js'

const streamDefault = Object.freeze({
  Duplex,
  PassThrough,
  Readable,
  Stream,
  Transform,
  Writable,
  finished,
  pipeline
})

export interface NodeStreamSyntheticModule {
  readonly default: typeof streamDefault
  readonly Duplex: typeof Duplex
  readonly finished: typeof finished
  readonly PassThrough: typeof PassThrough
  readonly pipeline: typeof pipeline
  readonly Readable: typeof Readable
  readonly Stream: typeof Stream
  readonly Transform: typeof Transform
  readonly Writable: typeof Writable
}

export interface NodeStreamPromisesSyntheticModule {
  readonly finished: typeof finishedPromise
  readonly pipeline: typeof pipelinePromise
}

export interface NodeStreamWebSyntheticModule {
  readonly ReadableStream: typeof ReadableStream
  readonly ReadableStreamDefaultController: typeof ReadableStreamDefaultController
  readonly ReadableStreamDefaultReader: typeof ReadableStreamDefaultReader
  readonly TransformStream: typeof TransformStream
  readonly TransformStreamDefaultController: typeof TransformStreamDefaultController
  readonly WritableStream: typeof WritableStream
  readonly WritableStreamDefaultController: typeof WritableStreamDefaultController
  readonly WritableStreamDefaultWriter: typeof WritableStreamDefaultWriter
}

export interface StreamSyntheticModules {
  readonly 'node:stream': NodeStreamSyntheticModule
  readonly 'node:stream/promises': NodeStreamPromisesSyntheticModule
  readonly 'node:stream/web': NodeStreamWebSyntheticModule
}

export type StreamSyntheticModule = StreamSyntheticModules[keyof StreamSyntheticModules]

export interface StreamSyntheticModuleDescriptor {
  readonly exportNames: readonly string[]
}

export interface StreamSyntheticModuleBinding<
  Namespace extends StreamSyntheticModule = StreamSyntheticModule,
> {
  readonly descriptor: StreamSyntheticModuleDescriptor
  readonly namespace: Namespace
}

export type StreamSyntheticModuleBindings = Readonly<
  {
    [Specifier in keyof StreamSyntheticModules]: StreamSyntheticModuleBinding<
      StreamSyntheticModules[Specifier]
    >
  }
>

export const createStreamSyntheticModules = (): StreamSyntheticModules =>
  Object.freeze({
    'node:stream': Object.freeze({
      default: streamDefault,
      Duplex,
      finished,
      PassThrough,
      pipeline,
      Readable,
      Stream,
      Transform,
      Writable
    }),
    'node:stream/promises': Object.freeze({
      finished: finishedPromise,
      pipeline: pipelinePromise
    }),
    'node:stream/web': Object.freeze({
      ReadableStream,
      ReadableStreamDefaultController,
      ReadableStreamDefaultReader,
      TransformStream,
      TransformStreamDefaultController,
      WritableStream,
      WritableStreamDefaultController,
      WritableStreamDefaultWriter
    })
  })

export const createStreamSyntheticModuleBindings = (): StreamSyntheticModuleBindings => {
  const namespaces = createStreamSyntheticModules()
  const bindings: Partial<Record<StreamModuleSpecifier, StreamSyntheticModuleBinding>> = {}
  for (const specifier of Object.keys(namespaces) as Array<keyof StreamSyntheticModules>) {
    const namespace = namespaces[specifier]
    bindings[specifier] = Object.freeze({
      descriptor: Object.freeze({ exportNames: Object.freeze(Object.keys(namespace)) }),
      namespace
    })
  }
  return Object.freeze(bindings) as StreamSyntheticModuleBindings
}
