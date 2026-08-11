/* eslint-disable max-lines -- endpoint validation, cancellable exchange and forward cleanup share one channel owner. */

import { Buffer } from 'node:buffer'
import { createConnection } from 'node:net'

import { androidAdbEndpointAbsent, removeVerifiedAndroidAdbLease } from './android-adb-lease-actions.mjs'
import { serviceError } from './errors.mjs'

export const ANDROID_CONTROL_ENDPOINT = 'no_backup/holonomy/session-v2/control/endpoint.v2'
const MAX_FRAME_BYTES = 1024 * 1024
const PACKAGE = 'ai.oneworks.holonomy.e2e'

const parseEndpoint = value => {
  const lines = value.trimEnd().split('\n')
  if (
    lines.length !== 3 || lines[0] !== '2' || !/^\d{1,10}$/u.test(lines[1]) ||
    !/^[\w.-]{1,128}$/u.test(lines[2])
  ) {
    throw serviceError('service.unavailable', 'Android control endpoint is invalid')
  }
  return Object.freeze({ processId: Number(lines[1]), socketName: lines[2] })
}

const frame = value => {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw serviceError('service.limit_exceeded', 'Android control command exceeds its limit')
  }
  const output = Buffer.allocUnsafe(body.byteLength + 4)
  output.writeUInt32BE(body.byteLength, 0)
  body.copy(output, 4)
  return output
}

const exchange = (port, value, timeoutMs, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(serviceError('service.unavailable', 'Android control was cancelled'))
      return
    }
    const socket = createConnection({ host: '127.0.0.1', port })
    const chunks = []
    let bytes = 0
    let settled = false
    function finish(error, result) {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      error == null ? resolve(result) : reject(error)
    }
    function abort() {
      finish(serviceError('service.unavailable', 'Android control was cancelled'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    socket.setTimeout(timeoutMs, () => finish(serviceError('service.unavailable', 'Android control timed out')))
    socket.once('error', () => finish(serviceError('service.unavailable', 'Android control connection failed')))
    socket.on('data', chunk => {
      bytes += chunk.byteLength
      if (bytes > MAX_FRAME_BYTES + 4) {
        finish(serviceError('service.limit_exceeded', 'Android control reply exceeds its limit'))
        return
      }
      chunks.push(chunk)
      const joined = Buffer.concat(chunks)
      if (joined.byteLength < 4) return
      const length = joined.readUInt32BE(0)
      if (length > MAX_FRAME_BYTES) {
        finish(serviceError('service.limit_exceeded', 'Android control reply exceeds its limit'))
        return
      }
      if (joined.byteLength < length + 4) return
      try {
        finish(undefined, JSON.parse(joined.subarray(4, length + 4).toString('utf8')))
      } catch {
        finish(serviceError('service.unavailable', 'Android control reply is invalid'))
      }
    })
    socket.once('connect', () => socket.write(frame(value)))
  })

export class AndroidControlChannel {
  #exchange
  #forwards = new Map()
  #leaseStore
  #loaded = false
  #runAdb
  #timeoutMs

  constructor(options) {
    this.#exchange = options.exchange ?? exchange
    this.#leaseStore = options.leaseStore
    this.#runAdb = options.runAdb
    this.#timeoutMs = options.timeoutMs ?? 30_000
  }

  async prepare(serial, options = {}) {
    await this.#load()
    const descriptor = parseEndpoint(
      await this.#runAdb([
        '-s',
        serial,
        'shell',
        'run-as',
        'ai.oneworks.holonomy.e2e',
        'cat',
        ANDROID_CONTROL_ENDPOINT
      ], { signal: options.signal })
    )
    const processIds = await this.#runAdb([
      '-s',
      serial,
      'shell',
      'pidof',
      PACKAGE
    ], { signal: options.signal })
    if (!processIds.trim().split(/\s+/u).includes(String(descriptor.processId))) {
      throw serviceError('service.unavailable', 'Android control endpoint is stale')
    }
    const existing = this.#forwards.get(serial)
    if (existing?.socketName === descriptor.socketName) return existing
    if (existing != null) await this.#remove(serial, existing.port)
    const output = await this.#runAdb([
      '-s',
      serial,
      'forward',
      'tcp:0',
      `localabstract:${descriptor.socketName}`
    ], { signal: options.signal })
    const port = Number(output.trim())
    if (!Number.isSafeInteger(port) || port <= 0) {
      throw serviceError('service.unavailable', 'Android control forward failed')
    }
    const current = { ...descriptor, port }
    this.#forwards.set(serial, current)
    try {
      await this.#leaseStore?.add({
        kind: 'control-forward',
        localPort: port,
        serial,
        socketName: descriptor.socketName
      })
    } catch (error) {
      this.#forwards.delete(serial)
      await this.#runAdb(['-s', serial, 'forward', '--remove', `tcp:${port}`]).catch(() => undefined)
      throw error
    }
    return current
  }

  async send(serial, command, options = {}) {
    let endpoint = await this.prepare(serial, options)
    try {
      return await this.#exchange(endpoint.port, command, this.#timeoutMs, options.signal)
    } catch (error) {
      if (options.signal?.aborted) throw error
      await this.#remove(serial, endpoint.port)
      this.#forwards.delete(serial)
      endpoint = await this.prepare(serial, options)
      return await this.#exchange(endpoint.port, command, this.#timeoutMs, options.signal)
    }
  }

  async close() {
    await this.#load()
    const entries = [...this.#forwards.entries()]
    this.#forwards.clear()
    const outcomes = await Promise.allSettled(
      entries.map(([serial, value]) => this.#remove(serial, value.port))
    )
    const failure = outcomes.find(outcome => outcome.status === 'rejected')
    if (failure != null && failure.status === 'rejected') throw failure.reason
  }

  async #remove(serial, port) {
    const endpoint = `tcp:${port}`
    await removeVerifiedAndroidAdbLease(
      () => this.#runAdb(['-s', serial, 'forward', '--remove', endpoint]),
      async () =>
        androidAdbEndpointAbsent(
          await this.#runAdb(['-s', serial, 'forward', '--list']),
          serial,
          endpoint
        ),
      () =>
        this.#leaseStore?.remove(lease => (
          lease.kind === 'control-forward' && lease.serial === serial && lease.localPort === port
        ))
    )
  }

  async #load() {
    if (this.#loaded) return
    await this.#leaseStore?.open()
    for (const lease of this.#leaseStore?.list(value => value.kind === 'control-forward') ?? []) {
      this.#forwards.set(lease.serial, {
        port: lease.localPort,
        processId: 0,
        socketName: lease.socketName
      })
    }
    this.#loaded = true
  }
}
