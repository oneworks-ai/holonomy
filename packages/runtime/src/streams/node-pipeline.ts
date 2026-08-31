import { createDeferred } from './deferred.js'
import { invalidStreamArgument, streamAborted, streamPrematureClose, toStreamError } from './errors.js'
import { Readable } from './node-readable.js'
import { Stream } from './node-stream-base.js'
import type { RuntimePipeDestination, RuntimeStreamCallback } from './node-stream-types.js'
import type { Writable } from './node-writable.js'

export type RuntimePipelineStream = Readable | RuntimePipeDestination | Stream

export type RuntimeFinishedCleanup = () => void

export const finished = (
  stream: RuntimePipelineStream,
  callback: RuntimeStreamCallback
): RuntimeFinishedCleanup => {
  if (typeof callback !== 'function') {
    throw invalidStreamArgument('node:stream finished requires a callback')
  }
  const readable = stream as Partial<Readable>
  const writable = stream as Partial<Writable>
  const baseStream = stream instanceof Stream ? stream : undefined
  const waitReadable = 'readableEnded' in stream && readable.readableEnded !== true
  const waitWritable = 'writableFinished' in stream && writable.writableFinished !== true
  let readableDone = !waitReadable
  let writableDone = !waitWritable
  let settled = false
  const removeListeners = () => {
    stream.off('end', onEnd)
    stream.off('error', onError)
    stream.off('finish', onFinish)
    stream.off('close', onClose)
  }
  const cleanup = () => {
    if (settled) return
    settled = true
    removeListeners()
  }
  const settle = (error?: Error | null) => {
    if (settled) return
    settled = true
    removeListeners()
    callback(error)
  }
  const complete = () => {
    if (readableDone && writableDone) settle()
  }
  const onEnd = () => {
    readableDone = true
    complete()
  }
  const onError = (error: Error) => settle(error)
  const onFinish = () => {
    writableDone = true
    complete()
  }
  const onClose = () => {
    if (!readableDone || !writableDone) settle(prematureCloseError(stream))
    else settle()
  }
  const settleDestroyed = () => {
    if (baseStream?.destroyError !== undefined) settle(baseStream.destroyError)
    else if (!readableDone || !writableDone) settle(prematureCloseError(stream))
    else settle()
  }
  if (!waitReadable && !waitWritable) {
    Promise.resolve().then(() => settle())
    return cleanup
  }
  if (baseStream?.destroyCompleted === true) {
    Promise.resolve().then(settleDestroyed)
    return cleanup
  }
  if ((stream as { readonly closed?: boolean }).closed === true) {
    Promise.resolve().then(() => settle(prematureCloseError(stream)))
    return cleanup
  }
  stream.once('end', onEnd)
  stream.once('error', onError)
  stream.once('finish', onFinish)
  stream.once('close', onClose)
  if (baseStream?.destroyed === true) {
    void baseStream.destroyedPromise().then(settleDestroyed)
  }
  return cleanup
}

export const finishedPromise = (stream: RuntimePipelineStream): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    finished(stream, error => {
      if (error == null) resolve()
      else reject(error)
    })
  })

export const pipelinePromise = async (...streams: RuntimePipelineStream[]): Promise<void> => {
  if (streams.length < 2) {
    throw invalidStreamArgument('pipeline requires at least two streams')
  }
  const errorDeferred = createDeferred<never>()
  const onError = (error: Error) => errorDeferred.reject(error)
  for (const stream of streams) stream.once('error', onError)
  try {
    for (let index = 0; index < streams.length - 1; index += 1) {
      const source = streams[index]
      const destination = streams[index + 1]
      const pipeDestination = destination as Partial<RuntimePipeDestination> | undefined
      if (!(source instanceof Readable) || typeof pipeDestination?.write !== 'function') {
        throw invalidStreamArgument('pipeline supports Readable to Writable-compatible streams')
      }
      source.pipe(pipeDestination as RuntimePipeDestination)
    }
    await Promise.race([
      Promise.all(streams.map(stream => finishedPromise(stream))).then(() => undefined),
      errorDeferred.promise
    ])
  } catch (error) {
    const streamError = toStreamError(error, streamAborted)
    await Promise.all(streams.map(stream => destroyForPipeline(stream, streamError)))
    throw streamError
  } finally {
    for (const stream of streams) stream.off('error', onError)
  }
}

export const pipeline = (
  ...arguments_: Array<RuntimePipelineStream | RuntimeStreamCallback>
): RuntimePipelineStream => {
  const callback = arguments_.at(-1)
  if (typeof callback !== 'function') {
    throw invalidStreamArgument('node:stream pipeline requires a callback')
  }
  const streams = arguments_.slice(0, -1) as RuntimePipelineStream[]
  const destination = streams.at(-1)
  if (destination === undefined) {
    throw invalidStreamArgument('pipeline requires at least two streams')
  }
  let callbackCalled = false
  const complete: RuntimeStreamCallback = (error) => {
    if (callbackCalled) return
    callbackCalled = true
    callback(error)
  }
  void pipelinePromise(...streams).then(
    () => complete(),
    error => complete(toStreamError(error, streamAborted))
  )
  return destination
}

const destroyForPipeline = (
  stream: RuntimePipelineStream,
  error: Error
): Promise<void> => {
  const destroy = stream.destroy
  if (destroy === undefined) return Promise.resolve()
  const onError = () => undefined
  stream.on('error', onError)
  Reflect.apply(destroy, stream, [error])
  const completion = stream instanceof Stream
    ? stream.destroyedPromise()
    : Promise.resolve()
  return completion.finally(() => stream.off('error', onError))
}

const prematureCloseError = (stream: RuntimePipelineStream): Error =>
  stream instanceof Stream ? stream.getPrematureCloseError() : streamPrematureClose()
