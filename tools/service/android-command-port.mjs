/* eslint-disable max-lines -- installation, control fallback and ADB lease cleanup share one Android command owner. */

import { randomBytes } from 'node:crypto'

import { androidBuildEnvironment, androidRoot, findAdb } from '../android-devtools-adb.mjs'
import {
  cleanupAndroidProcessLeases,
  persistAndroidAdbLease,
  removeAndroidAdbForward,
  removeAndroidAdbReverse
} from './android-adb-lease-actions.mjs'
import { AndroidAdbLeaseStore } from './android-adb-lease-store.mjs'
import { executeAndroidCommand } from './android-command-executor.mjs'
import { AndroidControlChannel } from './android-control-channel.mjs'
import { submitStoredAndroidCommand } from './android-stored-command.mjs'
import { serviceError } from './errors.mjs'

const PACKAGE = 'ai.oneworks.holonomy.e2e'

const mapAndroidError = code => {
  if (code === 'session.isolation_unsupported') {
    return serviceError('process.isolation_unsupported', 'Android isolated process mode is unsupported')
  }
  if (code === 'session.not_found') return serviceError('service.not_found', 'Android runtime was not found')
  if (code === 'session.limit_exceeded') {
    return serviceError('service.conflict', 'Android runtime capacity is exhausted')
  }
  if (code === 'session.generation_conflict' || code === 'session.stale_generation') {
    return serviceError('service.precondition_failed', 'Android generation is stale')
  }
  return serviceError('service.unavailable', 'Android session command failed')
}
export { executeAndroidCommand } from './android-command-executor.mjs'

export class AndroidSessionCommandPort {
  #adb
  #build
  #channel
  #execute
  #installed = new Set()
  #installing = new Map()
  #leaseStore
  #timeoutMs

  constructor(options = {}) {
    this.#adb = options.adb ?? findAdb()
    this.#build = options.build !== false
    this.#execute = options.execute ?? executeAndroidCommand
    this.#leaseStore = options.leaseStore ?? new AndroidAdbLeaseStore({ file: options.leaseStateFile })
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#channel = options.channel ?? new AndroidControlChannel({
      leaseStore: this.#leaseStore,
      runAdb: (args, runOptions = {}) =>
        this.#execute(this.#adb, args, { signal: runOptions.signal, timeoutMs: this.#timeoutMs }),
      timeoutMs: this.#timeoutMs
    })
  }

  async listDevices() {
    const output = await this.#execute(this.#adb, ['devices', '-l'], { timeoutMs: this.#timeoutMs })
    return output.split('\n').slice(1).filter(Boolean).map(line => {
      const [serial, state, ...metadata] = line.trim().split(/\s+/u)
      const model = metadata.find(value => value.startsWith('model:'))?.slice(6)
      return {
        id: `android:${serial}`,
        kind: serial.startsWith('emulator-') ? 'emulator' : 'physical',
        ...(model == null ? {} : { model }),
        platform: 'android',
        serial,
        state: state === 'device' ? 'online' : state === 'unauthorized' ? 'unauthorized' : 'offline'
      }
    })
  }

  async ensureInstalled(serial, options = {}) {
    if (this.#installed.has(serial)) return
    const existing = this.#installing.get(serial)
    if (existing != null) return await existing
    const pending = this.#install(serial, options)
    this.#installing.set(serial, pending)
    try {
      await pending
    } finally {
      this.#installing.delete(serial)
    }
  }

  async #install(serial, options) {
    if (this.#build) {
      await this.#execute('./gradlew', ['--no-daemon', ':e2e:installDebug'], {
        cwd: androidRoot,
        env: androidBuildEnvironment(this.#adb),
        maxBytes: 16 * 1024 * 1024,
        signal: options.signal,
        timeoutMs: 5 * 60_000
      })
    }
    await this.#execute(this.#adb, ['-s', serial, 'shell', 'pm', 'path', PACKAGE], {
      signal: options.signal,
      timeoutMs: this.#timeoutMs
    })
    this.#installed.add(serial)
  }

  async command(serial, input, options = {}) {
    await this.ensureInstalled(serial, options)
    const commandId = randomBytes(16).toString('hex')
    const command = { ...input, commandId, protocolVersion: 2 }
    let reply
    try {
      reply = await this.#channel.send(serial, command, { signal: options.signal })
    } catch (error) {
      if (options.signal?.aborted) throw error
      reply = await submitStoredAndroidCommand({
        adb: this.#adb,
        command,
        commandId,
        execute: this.#execute,
        serial,
        signal: options.signal,
        timeoutMs: this.#timeoutMs
      })
      await this.#channel.prepare(serial).catch(() => undefined)
    }
    if (reply.ack?.accepted !== true) throw mapAndroidError(reply.ack?.errorCode)
    return reply
  }

  async close() {
    await this.#channel.close()
  }

  async forwardInspector(serial, socketName, owner = {}) {
    const output = await this.#execute(
      this.#adb,
      ['-s', serial, 'forward', 'tcp:0', `localabstract:${socketName}`],
      { timeoutMs: this.#timeoutMs }
    )
    const port = Number(output.trim())
    if (!Number.isSafeInteger(port) || port <= 0) throw serviceError('service.unavailable', 'ADB forward failed')
    await persistAndroidAdbLease(this.#leaseStore, {
      generation: owner.generation,
      kind: 'inspector-forward',
      localPort: port,
      processId: owner.processId,
      serial,
      socketName
    }, () =>
      this.#execute(this.#adb, ['-s', serial, 'forward', '--remove', `tcp:${port}`], {
        timeoutMs: this.#timeoutMs
      }))
    return port
  }

  async removeForward(serial, port) {
    await removeAndroidAdbForward({
      adb: this.#adb,
      execute: this.#execute,
      port,
      serial,
      store: this.#leaseStore,
      timeoutMs: this.#timeoutMs
    })
  }

  async reverse(serial, port, owner = {}) {
    await this.#execute(this.#adb, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`], {
      timeoutMs: this.#timeoutMs
    })
    await persistAndroidAdbLease(this.#leaseStore, {
      generation: owner.generation,
      kind: 'fixture-reverse',
      localPort: port,
      processId: owner.processId,
      remotePort: port,
      serial
    }, () =>
      this.#execute(this.#adb, ['-s', serial, 'reverse', '--remove', `tcp:${port}`], {
        timeoutMs: this.#timeoutMs
      }))
  }

  async removeReverse(serial, port) {
    await removeAndroidAdbReverse({
      adb: this.#adb,
      execute: this.#execute,
      port,
      serial,
      store: this.#leaseStore,
      timeoutMs: this.#timeoutMs
    })
  }

  async cleanupProcess(processId, generation) {
    return await cleanupAndroidProcessLeases(
      this.#leaseStore,
      processId,
      generation,
      (serial, port) => this.removeForward(serial, port),
      (serial, port) => this.removeReverse(serial, port)
    )
  }
}
export const createAndroidSessionCommandPort = options => new AndroidSessionCommandPort(options)
