import { childProcessRecordV1, invalidChildProcessValueV1 } from './guest-child-process-support.js'

export interface PreparedChildProcessAbortSignalV1 {
  readonly add: (listener: () => void) => void
  readonly readAborted: () => boolean
  readonly remove: (listener: () => void) => void
}

export const prepareChildProcessAbortSignalV1 = (
  signal: unknown
): PreparedChildProcessAbortSignalV1 | undefined => {
  if (signal == null) return undefined
  const source = childProcessRecordV1(signal) as {
    aborted?: unknown
    addEventListener?: unknown
    removeEventListener?: unknown
  }
  const addEventListener = source.addEventListener
  const removeEventListener = source.removeEventListener
  if (
    typeof addEventListener !== 'function' || typeof removeEventListener !== 'function' ||
    typeof source.aborted !== 'boolean'
  ) {
    return invalidChildProcessValueV1('Invalid child process signal')
  }
  return Object.freeze({
    add(listener: () => void) {
      addEventListener.call(signal, 'abort', listener, { once: true })
    },
    readAborted() {
      if (typeof source.aborted !== 'boolean') {
        return invalidChildProcessValueV1('Invalid child process signal')
      }
      return source.aborted
    },
    remove(listener: () => void) {
      removeEventListener.call(signal, 'abort', listener)
    }
  })
}

export const attachChildProcessAbortV1 = (
  signal: PreparedChildProcessAbortSignalV1 | undefined,
  child: Record<string, unknown>
) => {
  if (signal == null) return
  let active = true
  const abort = () => {
    if (!active) return
    active = false
    try {
      ;(child.kill as Function)('SIGTERM')
    } catch {
      // A concurrent close wins without making AbortController.abort() throw.
    }
  }
  const close = () => {
    active = false
    signal.remove(abort)
  }
  if (signal.readAborted()) abort()
  else {
    signal.add(abort)
    ;(child.once as Function)('close', close)
  }
}
