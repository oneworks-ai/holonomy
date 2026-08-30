import { closeProcessStdinV1 } from './capability-process-publications.mjs'
import { binary, nodeError } from './capability-process-support.mjs'

export const bindNodeProcessChildEventsV1 = (state, onClose) => {
  const { child, childEvents } = state
  child.once('spawn', () => childEvents.emit({ event: 'spawn', tuple: [] }))
  child.once('error', () => {
    childEvents.emit({ event: 'error', tuple: [nodeError('ERR_OPERATION_FAILED')] })
  })
  child.once('exit', (code, signal) => childEvents.emit({ event: 'exit', tuple: [code, signal] }))
  child.once('close', (code, signal) => {
    childEvents.emit({ event: 'close', tuple: [code, signal] })
    onClose()
  })
}

export const bindNodeProcessReadableV1 = (stream, events, state, close) => {
  if (stream == null) return
  stream.on('data', chunk => {
    if (!events.emit({ event: 'data', tuple: [binary(chunk)] }, chunk.byteLength) && !state.outputFailed) {
      state.outputFailed = true
      const error = nodeError('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      events.fail(error)
      state.childEvents.emit({ event: 'error', tuple: [error] })
      close()
    }
  })
  stream.once('end', () => events.emit({ event: 'end', tuple: [] }))
  stream.once('error', () => events.emit({ event: 'error', tuple: [nodeError('EIO')] }))
  stream.once('close', () => events.emit({ event: 'close', tuple: [] }))
}

export const bindNodeProcessStdinV1 = (stream, state) => {
  if (stream == null) return
  stream.on('error', error => {
    state.stdinError = nodeError(error?.code === 'ERR_INVALID_STATE' ? 'ERR_INVALID_STATE' : 'EIO')
  })
  stream.once('close', () => closeProcessStdinV1(state))
}
