import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

const errorValue = value => value instanceof Error ? value : new Error('Process Backend failed')

const processReady = () => {
  let reject
  let resolve
  const promise = new Promise((resolveValue, rejectValue) => {
    reject = rejectValue
    resolve = resolveValue
  })
  promise.catch(() => undefined)
  return { promise, reject, resolve }
}

const writableStdin = ready => {
  let closing
  let terminated = false
  const close = () => terminated ? Promise.resolve() : closing ??= ready.promise.then(process => process.closeStdin())
  const stream = new Writable({
    destroy(error, callback) {
      close().then(
        () => callback(error),
        failure => callback(error ?? errorValue(failure))
      )
    },
    final(callback) {
      close().then(
        () => callback(),
        error => callback(errorValue(error))
      )
    },
    write(chunk, _encoding, callback) {
      const copy = Uint8Array.from(chunk)
      ready.promise.then(process => process.writeStdin(copy)).then(
        () => callback(),
        error => callback(errorValue(error))
      )
    }
  })
  return {
    stream,
    terminate() {
      terminated = true
      if (!stream.destroyed) stream.destroy()
    }
  }
}

export const createNodeEnvironmentChildV1 = ({ environment, onClose, request, stdio }) => {
  const child = new EventEmitter()
  const ready = processReady()
  const controller = new AbortController()
  const stdout = stdio[1] === 'pipe' ? new PassThrough() : null
  const stderr = stdio[2] === 'pipe' ? new PassThrough() : null
  const stdinResource = stdio[0] === 'pipe' ? writableStdin(ready) : null
  const stdin = stdinResource?.stream ?? null
  let closed = false
  let exited = false
  let pendingSignal
  Object.assign(child, { pid: undefined, stderr, stdin, stdout })

  const close = (code, signal) => {
    if (closed) return
    closed = true
    stdout?.end()
    stderr?.end()
    stdinResource?.terminate()
    child.emit('close', code, signal)
    onClose()
  }
  const fail = error => {
    const failure = errorValue(error)
    ready.reject(failure)
    child.emit('error', failure)
    if (!exited) {
      exited = true
      child.emit('exit', null, null)
    }
    close(null, null)
  }
  const sink = Object.freeze({
    close,
    error: error => child.emit('error', errorValue(error)),
    exit: (code, signal) => {
      if (exited) return
      exited = true
      child.emit('exit', code, signal)
    },
    stderr: chunk => stderr?.write(Buffer.from(chunk)),
    stdout: chunk => stdout?.write(Buffer.from(chunk))
  })

  Promise.resolve(environment).then(value =>
    value.spawn({
      ...request,
      signal: controller.signal,
      stdio
    }, sink)
  ).then(async process => {
    if (closed) {
      await process.signal('SIGKILL').catch(() => undefined)
      return
    }
    ready.resolve(process)
    child.emit('spawn')
    if (pendingSignal != null) await process.signal(pendingSignal)
  }).catch(fail)

  return Object.freeze({
    child,
    killTree(signal) {
      if (closed) return
      pendingSignal = signal
      ready.promise.then(process => process.signal(signal)).catch(() => undefined)
    }
  })
}
