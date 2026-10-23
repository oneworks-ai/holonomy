import { CapabilityInvocationError } from '../../../../packages/runtime/src/kernel/errors.ts'
import { utf8ByteLength } from '../../../../packages/runtime/src/kernel/validation.ts'

import { decodeNativeProcessInputV1, describeNativeProcessOutputV1 } from './process-v86-command.mjs'

const MAX_PENDING_STDIN_COMMANDS = 64

/** Only adapts asynchronous HoloUV process I/O to the shared synchronous Host port. */
export class NativeV86ProcessHostPortV1 {
  #backend

  constructor(backend) {
    this.#backend = backend
    this.descriptor = backend.descriptor
  }

  byteLengthUtf8(value) {
    return utf8ByteLength(value)
  }
  decodeInput(value) {
    return decodeNativeProcessInputV1(value)
  }
  describeOutput(bytes) {
    return describeNativeProcessOutputV1(bytes)
  }
  prepareLaunch(input) {
    return this.#backend.prepareLaunch(input)
  }
  poll() {
    this.#backend.poll()
  }
  closeGeneration(generation) {
    return this.#backend.closeGeneration(generation)
  }

  resolveNetwork(input) {
    return this.#backend.resolveNetwork(input)
  }

  spawn(launch, options, sink) {
    const { lease, request } = this.#backend.spawn(launch, options, sink)
    const controller = new AbortController()
    let process
    let closed = false
    let spawned = false
    let failed = false
    let stdinEnded = false
    let stdoutClosed = request.stdio[1] === 'ignore'
    let stderrClosed = request.stdio[2] === 'ignore'
    let pendingSignal
    let pendingStdinCommands = 0
    let stdinChain = Promise.resolve()
    const announceSpawn = () => {
      if (!spawned && !closed) {
        spawned = true
        sink.spawn()
      }
    }
    const release = () => {
      void lease.release().catch(() => undefined)
    }
    const finish = (code, signal) => {
      if (closed) return
      closed = true
      controller.abort()
      if (!stdoutClosed) {
        stdoutClosed = true
        if (failed) sink.stdoutError('EIO')
        else if (spawned) sink.stdoutEnd()
        sink.stdoutClose()
      }
      if (!stderrClosed) {
        stderrClosed = true
        if (failed) sink.stderrError('EIO')
        else if (spawned) sink.stderrEnd()
        sink.stderrClose()
      }
      sink.stdinClose()
      sink.close(code, signal)
      release()
    }
    const fail = () => {
      if (closed) return
      if (!failed) sink.error('ERR_OPERATION_FAILED')
      failed = true
      if (spawned) sink.exit(null, null)
      finish(null, null)
    }
    const childSink = Object.freeze({
      close(code, signal) {
        announceSpawn()
        finish(code, signal)
      },
      error() {
        if (!closed && !failed) {
          failed = true
          sink.error('ERR_OPERATION_FAILED')
        }
      },
      exit(code, signal) {
        announceSpawn()
        if (!closed) sink.exit(code, signal)
      },
      stdout(bytes) {
        announceSpawn()
        if (!closed && !stdoutClosed) sink.stdout(Uint8Array.from(bytes))
      },
      stderr(bytes) {
        announceSpawn()
        if (!closed && !stderrClosed) sink.stderr(Uint8Array.from(bytes))
      }
    })
    const ready = Promise.resolve(lease.environment)
      .then(environment => environment.spawn({ ...request, signal: controller.signal }, childSink))
      .then(value => {
        process = value
        if (closed) {
          void value.signal('SIGKILL').catch(() => undefined)
          return value
        }
        announceSpawn()
        if (pendingSignal != null) void value.signal(pendingSignal).catch(fail)
        return value
      })
    ready.catch(fail)
    const command = (action, callbackId) => {
      pendingStdinCommands += 1
      const settled = stdinChain.then(() => ready).then(value => {
        if (closed) throw new Error('Process closed')
        return action(value)
      })
      // The supervisor rejects stdinClose while a preceding write is still
      // pending. Later commands wait for each acknowledgement in FIFO order.
      stdinChain = settled.catch(() => undefined)
      settled.then(
        () => {
          pendingStdinCommands -= 1
          sink.stdinCallback(callbackId, null)
        },
        () => {
          pendingStdinCommands -= 1
          sink.stdinCallback(callbackId, 'EIO')
        }
      )
    }
    return Object.freeze({
      writeStdin(bytes, callbackId) {
        if (closed || stdinEnded || request.stdio[0] !== 'pipe') {
          throw new Error('Process stdin is closed')
        }
        // Keep one of 64 slots available for the single end/destroy terminal.
        // Empty writes and writes without callbacks still consume a slot.
        if (pendingStdinCommands >= MAX_PENDING_STDIN_COMMANDS - 1) {
          throw new CapabilityInvocationError('resource.handle_limit', 'process.stdin.write')
        }
        const copy = Uint8Array.from(bytes)
        command(value => value.writeStdin(copy), callbackId)
        return true
      },
      endStdin(callbackId) {
        if (closed || stdinEnded || request.stdio[0] !== 'pipe') {
          throw new Error('Process stdin is closed')
        }
        stdinEnded = true
        command(value => value.closeStdin(), callbackId)
      },
      destroyStdio(index) {
        if (index === 0) {
          if (!stdinEnded && !closed && request.stdio[0] === 'pipe') {
            stdinEnded = true
            command(value => value.closeStdin(), undefined)
          }
          sink.stdinClose()
        } else if (index === 1 && !stdoutClosed) {
          stdoutClosed = true
          sink.stdoutClose()
        } else if (index === 2 && !stderrClosed) {
          stderrClosed = true
          sink.stderrClose()
        }
      },
      signal(signal) {
        if (closed) return
        pendingSignal = signal
        if (process != null) void process.signal(signal).catch(fail)
      }
    })
  }
}
