import { serviceError } from './errors.mjs'

const unavailable = () => serviceError('service.unavailable', 'Inspector transport is unavailable')

export class CdpWebSocketTransport {
  #listeners = new Set()
  #pending = new Map()
  #ready
  #socket
  #timeoutMs

  constructor(url, options = {}) {
    this.#timeoutMs = options.timeoutMs ?? 10_000
    const WebSocketConstructor = options.WebSocket ?? globalThis.WebSocket
    if (typeof WebSocketConstructor !== 'function') {
      throw serviceError('service.unsupported', 'WebSocket client support is unavailable')
    }
    this.#socket = new WebSocketConstructor(url)
    this.#ready = new Promise((resolve, reject) => {
      this.#socket.addEventListener('open', resolve, { once: true })
      this.#socket.addEventListener('error', () => reject(unavailable()), { once: true })
    })
    this.#socket.addEventListener('message', event => this.#receive(event.data))
    this.#socket.addEventListener('close', () => this.#closePending())
  }

  async send(message) {
    await this.#ready
    if (!Number.isSafeInteger(message.id)) throw serviceError('service.invalid_request', 'CDP request id is invalid')
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(message.id)
        reject(unavailable())
      }, this.#timeoutMs)
      this.#pending.set(message.id, { reject, resolve, timeout })
      this.#socket.send(JSON.stringify(message))
    })
  }

  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  close() {
    this.#socket.close()
    this.#closePending()
  }

  #receive(data) {
    let message
    try {
      message = JSON.parse(String(data))
    } catch {
      return
    }
    if (Number.isSafeInteger(message.id)) {
      const pending = this.#pending.get(message.id)
      if (pending == null) return
      clearTimeout(pending.timeout)
      this.#pending.delete(message.id)
      pending.resolve(message)
      return
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(message)
      } catch {
        this.#listeners.delete(listener)
      }
    }
  }

  #closePending() {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(unavailable())
    }
    this.#pending.clear()
  }
}
