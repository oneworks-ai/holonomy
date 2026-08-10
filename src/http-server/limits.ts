import { createHttpServerError } from './errors.js'
import { DEFAULT_HTTP_SERVER_LIMITS } from './types.js'

import type { HttpServerLimits } from './types.js'

export const resolveHttpServerLimits = (
  input: Partial<HttpServerLimits> | undefined
): Readonly<HttpServerLimits> => {
  const resolved = { ...DEFAULT_HTTP_SERVER_LIMITS, ...input }
  for (const value of Object.values(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw createHttpServerError('ERR_HOLONOMY_HTTP_INVALID_ARGUMENT')
    }
  }
  if (
    resolved.maxChunkBytes > resolved.maxRequestBodyBytes ||
    resolved.maxChunkBytes > resolved.maxResponseBodyBytes ||
    resolved.maxWebSocketMessageBytes > resolved.maxWebSocketBufferedBytes
  ) {
    throw createHttpServerError('ERR_HOLONOMY_HTTP_INVALID_ARGUMENT')
  }
  return Object.freeze(resolved)
}
