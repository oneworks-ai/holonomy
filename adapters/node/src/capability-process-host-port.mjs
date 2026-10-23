import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { createNodeProcessNetworkResolutionV1 } from './capability-process-network-resolution.mjs'

// Node translates Backend child/stream objects into the shared event/command port.
// It owns no Policy, Process resource ledger or publication state.
export class NodeProcessHostPortV1 {
  #backend
  #networkResolutionOptions

  constructor(backend, networkResolutionOptions = {}) {
    this.#backend = backend
    this.#networkResolutionOptions = networkResolutionOptions
    this.descriptor = backend.descriptor
  }

  byteLengthUtf8(value) {
    return Buffer.byteLength(value)
  }

  decodeInput(value) {
    return typeof value === 'string' ? Buffer.from(value) : Buffer.from(value.base64, 'base64')
  }

  describeOutput(bytes) {
    return Object.freeze({
      base64: Buffer.from(bytes).toString('base64'),
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  }

  prepareLaunch(input) {
    return this.#backend.prepareLaunch(input)
  }

  spawn(launch, options, sink) {
    const execution = this.#backend.spawn(launch, {
      cwd: launch.cwd,
      detached: true,
      env: options.env,
      shell: false,
      stdio: options.stdio
    }, { processResourceId: options.processResourceId })
    const child = execution.child
    child.once('spawn', () => sink.spawn())
    child.once('error', () => sink.error('ERR_OPERATION_FAILED'))
    child.once('exit', (code, signal) => sink.exit(code, signal))
    child.once('close', (code, signal) => sink.close(code, signal))
    for (const [stream, prefix] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      if (stream == null) continue
      stream.on('data', chunk => sink[prefix](chunk))
      stream.once('end', () => sink[`${prefix}End`]())
      stream.once('error', () => sink[`${prefix}Error`]('EIO'))
      stream.once('close', () => sink[`${prefix}Close`]())
    }
    child.stdin?.on('error', error => sink.stdinError(error?.code))
    child.stdin?.once('close', () => sink.stdinClose())
    const readable = index => index === 1 ? child.stdout : child.stderr
    return Object.freeze({
      writeStdin(bytes, callbackId) {
        if (child.stdin == null || child.stdin.destroyed) throw new Error('Process stdin is closed')
        return child.stdin.write(bytes, error => sink.stdinCallback(callbackId, error?.code ?? null))
      },
      endStdin(callbackId) {
        if (child.stdin == null || child.stdin.destroyed) throw new Error('Process stdin is closed')
        child.stdin.end(error => sink.stdinCallback(callbackId, error?.code ?? null))
      },
      destroyStdio(index) {
        if (index === 0) child.stdin?.destroy()
        else readable(index)?.destroy()
      },
      signal(signal) {
        execution.killTree(signal)
      }
    })
  }

  spawnSync(launch, options) {
    return this.#backend.spawnSync(launch, {
      ...options,
      cwd: launch.cwd,
      shell: false
    })
  }

  closeGeneration(generation) {
    return this.#backend.closeGeneration(generation)
  }

  resolveNetwork(input) {
    return createNodeProcessNetworkResolutionV1({
      ...input,
      ...this.#networkResolutionOptions
    })
  }
}
