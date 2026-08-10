import { invalidArgument } from './errors.js'
import type { NodeCoreCompatOptions } from './types.js'

export const DEFAULT_MAX_STDIO_CHUNK_BYTES = 1024 * 1024

export type ResolvedNodeCoreCompatOptions = Readonly<
  NodeCoreCompatOptions & { readonly maxStdioChunkBytes: number }
>

export const resolveMaxStdioChunkBytes = (value?: unknown): number => {
  const resolved = value === undefined ? DEFAULT_MAX_STDIO_CHUNK_BYTES : value
  if (
    typeof resolved !== 'number' ||
    !Number.isSafeInteger(resolved) ||
    resolved <= 0
  ) {
    invalidArgument(
      'maxStdioChunkBytes',
      'maxStdioChunkBytes must be a positive safe integer'
    )
  }
  return resolved as number
}

export const resolveNodeCoreCompatOptions = (
  options: NodeCoreCompatOptions
): ResolvedNodeCoreCompatOptions => {
  const maxStdioChunkBytes = resolveMaxStdioChunkBytes(options.maxStdioChunkBytes)
  return Object.freeze({ ...options, maxStdioChunkBytes })
}
