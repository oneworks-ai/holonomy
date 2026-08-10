export type StreamFeatureStatus = 'partial' | 'supported' | 'unsupported'

export interface StreamFeatureCapability {
  readonly status: StreamFeatureStatus
}

export interface StreamModuleCapability {
  readonly constraints: readonly string[]
  readonly features: Readonly<Record<string, StreamFeatureCapability>>
  readonly partial: readonly string[]
  readonly status: StreamFeatureStatus
  readonly supported: readonly string[]
  readonly unsupported: readonly string[]
}

const moduleCapability = (
  supported: readonly string[],
  partial: readonly string[],
  unsupported: readonly string[],
  constraints: readonly string[]
): StreamModuleCapability => {
  const features = Object.fromEntries([
    ...supported.map(name => [name, Object.freeze({ status: 'supported' })]),
    ...partial.map(name => [name, Object.freeze({ status: 'partial' })]),
    ...unsupported.map(name => [name, Object.freeze({ status: 'unsupported' })])
  ])
  return Object.freeze({
    constraints: Object.freeze([...constraints]),
    features: Object.freeze(features),
    partial: Object.freeze([...partial]),
    status: 'partial',
    supported: Object.freeze([...supported]),
    unsupported: Object.freeze([...unsupported])
  })
}

const WEB_CONSTRAINTS = [
  'Constructors are pure JavaScript and must be explicitly injected into a bare V8 global object.',
  'Default readers and writers are supported; BYOB readers and byte-stream controllers are not.',
  'Backpressure is in-memory and uses the configured count or byte-length strategy.',
  'Promise reactions rely on the engine microtask queue owned by the runtime event loop.',
  'Exception classes and exact timing are a documented subset of WHATWG Streams.'
] as const

const NODE_CONSTRAINTS = [
  'Streams are memory-only and accept UTF-8 strings, RuntimeBuffer and Uint8Array chunks.',
  'Event ordering is compatible with the tested production subset, not every Node timing edge case.',
  'Byte highWaterMark backpressure is supported; objectMode and encoding transforms are not.',
  'Explicit destroy emits close once; normal auto-destroy timing is partial for duplex streams.',
  'finished preserves an original destroy error by identity. Repeated no-error premature observations reuse one ERR_MOBILE_STREAM_PREMATURE_CLOSE object; Node uses ERR_STREAM_PREMATURE_CLOSE and does not promise that object identity.',
  'Pipe cleanup runs before user error listeners for runtime Stream destinations. Foreign writable destinations use append-listener fallback, so a throwing pre-existing error listener can prevent pipe cleanup.'
] as const

export const STREAM_CAPABILITY_MATRIX = Object.freeze(
  {
    modules: Object.freeze({
      'web:streams': moduleCapability(
        [
          'ReadableStream.constructor',
          'ReadableStream.getReader',
          'ReadableStream.cancel',
          'ReadableStreamDefaultReader.read',
          'ReadableStreamDefaultReader.constructor',
          'ReadableStreamDefaultReader.cancel',
          'ReadableStreamDefaultReader.releaseLock',
          'ReadableStreamDefaultController.enqueue',
          'ReadableStreamDefaultController.close',
          'ReadableStreamDefaultController.error',
          'ReadableStreamDefaultController.desiredSize',
          'WritableStream.constructor',
          'WritableStream.getWriter',
          'WritableStream.abort',
          'WritableStream.close',
          'WritableStreamDefaultWriter.write',
          'WritableStreamDefaultWriter.constructor',
          'WritableStreamDefaultWriter.abort',
          'WritableStreamDefaultWriter.close',
          'WritableStreamDefaultWriter.releaseLock',
          'WritableStreamDefaultWriter.desiredSize',
          'WritableStreamDefaultWriter.ready',
          'TransformStream.constructor',
          'TransformStreamDefaultController.enqueue',
          'TransformStreamDefaultController.error',
          'TransformStreamDefaultController.terminate',
          'queuingStrategy.highWaterMark',
          'queuingStrategy.size'
        ],
        ['exceptionIdentity', 'microtaskTiming', 'TransformStream.backpressureTiming'],
        [
          'ReadableStreamBYOBReader',
          'ReadableByteStreamController',
          'ReadableStream.tee',
          'ReadableStream.pipeTo',
          'ReadableStream.pipeThrough',
          'transferableStreams'
        ],
        WEB_CONSTRAINTS
      ),
      'node:stream': moduleCapability(
        [
          'Stream.destroy',
          'Readable',
          'Readable.push',
          'Readable.read',
          'Readable.pause',
          'Readable.resume',
          'Readable.asyncIterator',
          'Readable.from',
          'Readable.fromWeb',
          'Readable.pipe',
          'Readable.pipe.runtimeDestinationErrorOrdering',
          'Readable.unpipe',
          'Writable',
          'Writable.write',
          'Writable.end',
          'Writable.drain',
          'Duplex',
          'Transform',
          'Transform.readableBackpressure',
          'PassThrough',
          'finished.callback',
          'finished.cleanup',
          'finished.destroyErrorIdentity',
          'pipeline.callback',
          'events.data',
          'events.end',
          'events.finish',
          'events.close',
          'events.error'
        ],
        [
          'autoDestroyTiming',
          'destroyCallbackTiming',
          'Readable.read.size',
          'Duplex.allowHalfOpen',
          'finished.prematureCloseErrorIdentity',
          'Readable.pipe.foreignDestinationErrorOrdering'
        ],
        [
          'objectMode',
          'Readable.setEncoding',
          'Readable.toWeb',
          'Writable.fromWeb',
          'Writable.toWeb',
          'Duplex.fromWeb',
          'Duplex.toWeb',
          'Writable.cork',
          'Writable.uncork',
          'stream.compose'
        ],
        NODE_CONSTRAINTS
      ),
      'node:stream/promises': moduleCapability(
        ['pipeline', 'finished'],
        ['pipeline.options', 'finished.cleanup'],
        ['pipeline.iterableTransforms'],
        NODE_CONSTRAINTS
      ),
      'node:stream/web': moduleCapability(
        [
          'ReadableStream',
          'ReadableStreamDefaultController',
          'ReadableStreamDefaultReader',
          'WritableStream',
          'WritableStreamDefaultController',
          'WritableStreamDefaultWriter',
          'TransformStream',
          'TransformStreamDefaultController'
        ],
        ['WHATWGCompatibility'],
        ['ReadableStreamBYOBReader', 'ReadableByteStreamController'],
        WEB_CONSTRAINTS
      )
    }),
    version: 1
  } as const
)

export type StreamModuleSpecifier = keyof typeof STREAM_CAPABILITY_MATRIX.modules
