import { Buffer } from '../node-compat/buffer.js'
import type { RuntimeBuffer } from '../node-compat/buffer.js'
import type { NodeEventListener, NodeEventName } from '../node-compat/events.js'

import { invalidStreamArgument, streamNotSupported } from './errors.js'

export type RuntimeStreamChunk = RuntimeBuffer | Uint8Array | string
export type RuntimeStreamCallback = (error?: Error | null) => void
export type RuntimeTransformCallback = (
  error?: Error | null,
  output?: RuntimeStreamChunk
) => void

export interface RuntimeStreamDestroyOptions {
  readonly autoDestroy?: boolean
  readonly destroy?: (
    error: Error | null,
    callback: RuntimeStreamCallback
  ) => void
  readonly emitClose?: boolean
}

export interface RuntimeReadableOptions extends RuntimeStreamDestroyOptions {
  readonly highWaterMark?: number
  readonly objectMode?: boolean
  readonly read?: (size: number) => PromiseLike<void> | void
}

export interface RuntimeWritableOptions extends RuntimeStreamDestroyOptions {
  readonly decodeStrings?: boolean
  readonly final?: (callback: RuntimeStreamCallback) => void
  readonly highWaterMark?: number
  readonly objectMode?: boolean
  readonly write?: (
    chunk: RuntimeBuffer,
    encoding: 'buffer',
    callback: RuntimeStreamCallback
  ) => void
}

export interface RuntimeDuplexOptions extends RuntimeReadableOptions, RuntimeWritableOptions {
  readonly allowHalfOpen?: boolean
}

export interface RuntimeTransformOptions extends RuntimeDuplexOptions {
  readonly flush?: (callback: RuntimeTransformCallback) => void
  readonly transform?: (
    chunk: RuntimeBuffer,
    encoding: 'buffer',
    callback: RuntimeTransformCallback
  ) => void
}

export interface RuntimeWebReadableReader<Chunk = Uint8Array> {
  cancel: (reason?: unknown) => PromiseLike<void>
  read: () => PromiseLike<{ readonly done: boolean; readonly value?: Chunk }>
  releaseLock: () => void
}

export interface RuntimeWebReadableStream<Chunk = Uint8Array> {
  getReader: () => RuntimeWebReadableReader<Chunk>
}

export interface RuntimePipeDestination {
  destroy?: (error?: Error) => unknown
  emit?: (eventName: NodeEventName, ...args: unknown[]) => boolean
  listenerCount?: (eventName: NodeEventName) => number
  end: () => unknown
  off: (eventName: NodeEventName, listener: NodeEventListener) => unknown
  on: (eventName: NodeEventName, listener: NodeEventListener) => unknown
  once: (eventName: NodeEventName, listener: NodeEventListener) => unknown
  write: (chunk: RuntimeBuffer) => boolean
}

export interface PipeRecord {
  readonly cleanup: () => void
  readonly destination: RuntimePipeDestination
}

const DEFAULT_HIGH_WATER_MARK = 16 * 1024

export const normalizeHighWaterMark = (value: number | undefined): number => {
  const resolved = value ?? DEFAULT_HIGH_WATER_MARK
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw invalidStreamArgument('Node stream highWaterMark must be a non-negative safe integer')
  }
  return resolved
}

export const assertByteMode = (objectMode: boolean | undefined): void => {
  if (objectMode === true) throw streamNotSupported('Node stream objectMode')
}

export const normalizeChunk = (chunk: RuntimeStreamChunk): RuntimeBuffer => {
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (chunk instanceof Uint8Array) {
    return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  }
  throw invalidStreamArgument('Node streams accept only strings and Uint8Array chunks')
}
