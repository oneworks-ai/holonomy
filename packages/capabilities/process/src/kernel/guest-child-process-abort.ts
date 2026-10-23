import {
  childProcessAbortErrorV1,
  childProcessRecordV1,
  invalidChildProcessValueV1
} from './guest-child-process-support.js'

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
  child: Record<string, unknown>,
  emitError: (error: Error) => void,
  scheduleNextTick?: (callback: () => void) => void
) => {
  if (signal == null) return
  let active = true
  let initializing = true
  const scheduleAbort = (callback: () => void) => {
    if (scheduleNextTick != null) {
      try {
        scheduleNextTick(callback)
        return
      } catch {
        // A closing Runtime may reject admission; still settle this child locally.
      }
    }
    void Promise.resolve().then(callback)
  }
  const abort = () => {
    if (!active) return
    if (initializing) {
      scheduleAbort(abort)
      return
    }
    active = false
    try {
      signal.remove(abort)
    } catch {
      // A malformed listener implementation cannot suppress the admitted kill.
    }
    try {
      if ((child.kill as Function)('SIGTERM') === true) emitError(childProcessAbortErrorV1())
    } catch (error) {
      emitError(error instanceof Error ? error : new Error('Controlled child process failed'))
    }
  }
  const close = () => {
    active = false
    signal.remove(abort)
  }
  ;(child.once as Function)('exit', close)
  ;(child.once as Function)('close', close)
  if (signal.readAborted()) scheduleAbort(abort)
  else {
    signal.add(abort)
    if (signal.readAborted()) scheduleAbort(abort)
  }
  initializing = false
}
