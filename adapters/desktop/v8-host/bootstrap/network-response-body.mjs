import { RuntimeBuffer } from '../../../../packages/runtime/src/node-compat/buffer.ts'

export const nativeNetworkTransportError = error => {
  const code = error?.code === 'runtime.cancelled'
    ? 'aborted'
    : error?.code === 'provider.timeout'
    ? 'timeout'
    : error?.code === 'provider.connection_refused'
    ? 'connection_refused'
    : error?.code === 'provider.protocol_error'
    ? 'protocol_error'
    : error?.code === 'resource.byte_limit'
    ? 'response_too_large'
    : 'unavailable'
  return Object.assign(new Error('Native HTTP request failed'), { code })
}

export const createNativeResponseBody = (streamId, task, sync) => {
  let closed = false
  let active
  const close = () => {
    if (closed) return
    closed = true
    try {
      active?.abort()
    } catch {
      // Cleanup must not replace the pull terminal selected by the native transport.
    }
    try {
      sync({ kind: 'closeStream', streamId })
    } catch {
      // Closing is idempotent and best-effort after a terminal pull failure.
    }
  }
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      if (closed) return { done: true, value: undefined }
      const controller = new AbortController()
      active = controller
      try {
        const result = await task({ kind: 'pull', streamId }, controller.signal)
        if (result.done === true) {
          closed = true
          return { done: true, value: undefined }
        }
        if (result.done !== false || typeof result.body !== 'string') {
          close()
          throw Object.assign(new Error('Invalid native response chunk'), { code: 'protocol_error' })
        }
        return { done: false, value: new Uint8Array(RuntimeBuffer.from(result.body, 'base64')) }
      } catch (error) {
        close()
        throw nativeNetworkTransportError(error)
      } finally {
        if (active === controller) active = undefined
      }
    },
    async return() {
      close()
      return { done: true, value: undefined }
    }
  }
}
