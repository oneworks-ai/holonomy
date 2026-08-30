import { invalidStreamArgument } from './errors.js'

export interface RuntimeQueuingStrategy<Chunk> {
  readonly highWaterMark?: number
  readonly size?: (chunk: Chunk) => number
}

export const normalizeWebHighWaterMark = (
  strategy: { readonly highWaterMark?: number } | undefined,
  fallback: number
): number => {
  const value = strategy?.highWaterMark ?? fallback
  if (!Number.isFinite(value) || value < 0) {
    throw invalidStreamArgument('Stream highWaterMark must be a non-negative finite number')
  }
  return value
}

export const normalizeWebChunkSize = <Chunk>(
  strategy: RuntimeQueuingStrategy<Chunk> | undefined,
  chunk: Chunk
): number => {
  const size = strategy?.size?.(chunk) ?? 1
  if (!Number.isFinite(size) || size < 0) {
    throw invalidStreamArgument('Stream chunk size must be a non-negative finite number')
  }
  return size
}
