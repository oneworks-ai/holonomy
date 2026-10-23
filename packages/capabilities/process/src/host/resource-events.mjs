import { closeProcessStdinV1 } from './publications.mjs'
import { processError } from './support.mjs'

const readable = (state, events, bytes, port, close) => {
  if (state.outputFailed) return
  if (events.canAccept(bytes?.byteLength)) {
    try {
      if (events.emit({ event: 'data', tuple: [port.describeOutput(bytes)] }, bytes.byteLength)) return
    } catch {
      // A Host port failure is a bounded output failure, never raw Guest data.
    }
  }
  state.outputFailed = true
  const error = processError('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  events.fail(error)
  state.childEvents.emit({ event: 'error', tuple: [error] })
  close()
}

export const createProcessEventSinkV1 = (state, onClose, port, closeState) =>
  Object.freeze({
    spawn() {
      if (state.closed || state.spawned) return
      state.spawned = true
      state.childEvents.emit({ event: 'spawn', tuple: [] })
    },
    error() {
      if (state.closed || state.outputFailed) return
      state.childEvents.emit({ event: 'error', tuple: [processError('ERR_OPERATION_FAILED')] })
    },
    exit(code, signal) {
      if (state.closed || state.exited) return
      state.exited = true
      state.childEvents.emit({ event: 'exit', tuple: [code, signal] })
    },
    close(code, signal) {
      if (state.closed) return
      state.closed = true
      closeProcessStdinV1(state)
      state.stdoutEvents.emit({ event: 'close', tuple: [] })
      state.stderrEvents.emit({ event: 'close', tuple: [] })
      state.childEvents.emit({ event: 'close', tuple: [code, signal] })
      onClose()
    },
    stdout(bytes) {
      if (!state.closed) readable(state, state.stdoutEvents, bytes, port, () => closeState(state, 'SIGKILL'))
    },
    stdoutEnd() {
      if (!state.closed) state.stdoutEvents.emit({ event: 'end', tuple: [] })
    },
    stdoutError() {
      if (!state.closed) state.stdoutEvents.emit({ event: 'error', tuple: [processError('EIO')] })
    },
    stdoutClose() {
      if (!state.closed) state.stdoutEvents.emit({ event: 'close', tuple: [] })
    },
    stderr(bytes) {
      if (!state.closed) readable(state, state.stderrEvents, bytes, port, () => closeState(state, 'SIGKILL'))
    },
    stderrEnd() {
      if (!state.closed) state.stderrEvents.emit({ event: 'end', tuple: [] })
    },
    stderrError() {
      if (!state.closed) state.stderrEvents.emit({ event: 'error', tuple: [processError('EIO')] })
    },
    stderrClose() {
      if (!state.closed) state.stderrEvents.emit({ event: 'close', tuple: [] })
    },
    stdinError(code) {
      if (state.closed) return
      state.stdinError = processError(code === 'ERR_INVALID_STATE' ? 'ERR_INVALID_STATE' : 'EIO')
    },
    stdinClose() {
      closeProcessStdinV1(state)
    },
    stdinCallback(callbackId, code) {
      if (callbackId == null || !state.pendingStdinCallbacks.delete(callbackId)) return
      state.stdinEvents.emit({
        callbackId,
        error: code == null ? null : processError(
          code === 'ERR_INVALID_STATE' || code === 'ERR_STREAM_WRITE_AFTER_END'
            ? 'ERR_INVALID_STATE'
            : 'EIO'
        ),
        event: 'callback'
      })
    }
  })
