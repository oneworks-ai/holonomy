import { Buffer } from 'node:buffer'
import { createConnection } from 'node:net'

import { serviceError } from './errors.mjs'

const MAX_INBOUND = 1024 * 1024
const MAX_OUTBOUND = 64 * 1024
const MAX_PENDING = 32
const MAX_REQUEST_ID = 2_147_483_647
const MAX_QUEUED = 1024 * 1024

const unavailable = () => serviceError('service.unavailable', 'Native Inspector transport is unavailable')

// Rust accepts one Unix connection for an entire invocation. Lease wrappers
// therefore share this connection, but never share request IDs or ownership.
export class NativeInspectorConnection {
  #buffer = Buffer.alloc(0)
  #candidate
  #closed = false
  #leases = new Set()
  #nextId = 1
  #onResume
  #path
  #pending = new Map()
  #ready
  #socket
  #timeoutMs
  constructor(path, options = {}) {
    this.#path = path
    this.#onResume = options.onResume
    this.#timeoutMs = options.timeoutMs ?? 10_000
  }
  async connect() {
    if (this.#closed) throw unavailable()
    this.#ready ??= this.#open()
    await this.#ready
    if (this.#closed) throw unavailable()
  }
  lease() {
    if (this.#closed || this.#socket == null) throw unavailable()
    const owner = { closed: false, listeners: new Set() }
    this.#leases.add(owner)
    return Object.freeze({
      close: () => this.#closeLease(owner),
      send: async message => await this.#send(owner, message),
      subscribe: listener => {
        if (owner.closed || typeof listener !== 'function') throw unavailable()
        owner.listeners.add(listener)
        return () => owner.listeners.delete(listener)
      }
    })
  }
  async resume() {
    await this.connect()
    const lease = this.lease()
    try {
      const response = await lease.send({ id: 1, method: 'Runtime.runIfWaitingForDebugger' })
      if (response.error != null) throw unavailable()
    } finally {
      lease.close()
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.#candidate?.destroy()
    this.#socket?.destroy()
    for (const lease of [...this.#leases]) this.#closeLease(lease)
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(unavailable())
    }
    this.#pending.clear()
    this.#buffer = Buffer.alloc(0)
  }

  async #open() {
    const deadline = Date.now() + 5_000
    while (!this.#closed) {
      const socket = createConnection({ path: this.#path })
      this.#candidate = socket
      try {
        await new Promise((resolve, reject) => {
          socket.once('connect', resolve)
          socket.once('error', reject)
        })
        if (this.#closed) throw unavailable()
        this.#candidate = undefined
        this.#socket = socket
        socket.on('data', bytes => this.#receive(bytes))
        socket.once('close', () => this.close())
        socket.once('error', () => this.close())
        return
      } catch (error) {
        socket.destroy()
        if (this.#closed || Date.now() >= deadline || !['ENOENT', 'ECONNREFUSED'].includes(error?.code)) {
          this.close()
          throw unavailable()
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      } finally {
        if (this.#candidate === socket) this.#candidate = undefined
      }
    }
    throw unavailable()
  }

  async #send(owner, message) {
    await this.connect()
    if (owner.closed || this.#pending.size >= MAX_PENDING || this.#nextId > MAX_REQUEST_ID) {
      throw unavailable()
    }
    if (!Number.isSafeInteger(message?.id) || typeof message.method !== 'string') {
      throw serviceError('service.invalid_request', 'Native Inspector command is invalid')
    }
    const originalId = message.id
    const upstreamId = this.#nextId++
    const frame = Buffer.from(`${JSON.stringify({ ...message, id: upstreamId })}\n`)
    if (frame.byteLength > MAX_OUTBOUND || this.#socket.writableLength + frame.byteLength > MAX_QUEUED) {
      throw serviceError('service.limit_exceeded', 'Native Inspector command exceeds its limit')
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(upstreamId)
        reject(unavailable())
      }, this.#timeoutMs)
      this.#pending.set(upstreamId, { method: message.method, originalId, owner, reject, resolve, timer })
      try {
        this.#socket.write(frame, error => {
          if (error == null) return
          const pending = this.#pending.get(upstreamId)
          if (pending == null) return
          this.#pending.delete(upstreamId)
          clearTimeout(timer)
          reject(unavailable())
        })
      } catch {
        this.#pending.delete(upstreamId)
        clearTimeout(timer)
        reject(unavailable())
      }
    })
  }

  #receive(bytes) {
    this.#buffer = Buffer.concat([this.#buffer, bytes])
    if (this.#buffer.byteLength > MAX_INBOUND + 1) return this.close()
    while (true) {
      const end = this.#buffer.indexOf(10)
      if (end < 0) return
      if (end > MAX_INBOUND) return this.close()
      const frame = this.#buffer.subarray(0, end)
      this.#buffer = this.#buffer.subarray(end + 1)
      let message
      try {
        message = JSON.parse(frame.toString('utf8'))
      } catch {
        return this.close()
      }
      if (Number.isSafeInteger(message?.id)) {
        const pending = this.#pending.get(message.id)
        if (pending == null) continue
        this.#pending.delete(message.id)
        clearTimeout(pending.timer)
        if (pending.owner.closed) {
          pending.reject(unavailable())
          continue
        }
        if (pending.method === 'Runtime.runIfWaitingForDebugger' && message.error == null) {
          this.#onResume?.()
        }
        pending.resolve({ ...message, id: pending.originalId })
      } else if (typeof message?.method === 'string') {
        for (const lease of [...this.#leases]) {
          for (const listener of [...lease.listeners]) {
            try {
              listener(message)
            } catch {
              lease.listeners.delete(listener)
            }
          }
        }
      }
    }
  }

  #closeLease(owner) {
    if (owner.closed) return
    owner.closed = true
    owner.listeners.clear()
    this.#leases.delete(owner)
    for (const [id, pending] of this.#pending) {
      if (pending.owner !== owner) continue
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(unavailable())
    }
  }
}
