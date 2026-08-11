import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME_BYTES = 1024 * 1024

const frame = (opcode, payload) => {
  if (payload.byteLength < 126) return Buffer.concat([Buffer.from([0x80 | opcode, payload.byteLength]), payload])
  const header = Buffer.alloc(4)
  header[0] = 0x80 | opcode
  header[1] = 126
  header.writeUInt16BE(payload.byteLength, 2)
  return Buffer.concat([header, payload])
}

const sendJson = (socket, value) => {
  if (socket.destroyed) return
  socket.write(frame(0x1, Buffer.from(JSON.stringify(value))))
}

const rejectUpgrade = (socket, status) => {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`)
}

const parseFrame = buffer => {
  const final = (buffer[0] & 0x80) !== 0
  const opcode = buffer[0] & 0x0F
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7F
  let offset = 2
  if (!final || !masked) throw new Error('Invalid WebSocket frame')
  if (length === 126) {
    if (buffer.byteLength < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.byteLength < 10) return undefined
    const expanded = buffer.readBigUInt64BE(2)
    if (expanded > BigInt(MAX_FRAME_BYTES)) throw new Error('WebSocket frame exceeds its limit')
    length = Number(expanded)
    offset = 10
  }
  if (length > MAX_FRAME_BYTES) throw new Error('WebSocket frame exceeds its limit')
  if (buffer.byteLength < offset + 4 + length) return undefined
  const mask = buffer.subarray(offset, offset + 4)
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length))
  for (let index = 0; index < payload.byteLength; index += 1) payload[index] ^= mask[index % 4]
  return { bytes: offset + 4 + length, opcode, payload }
}

class WebSocketFrameDecoder {
  #buffer = Buffer.alloc(0)
  #handlers
  #tail = Promise.resolve()

  constructor(handlers) {
    this.#handlers = handlers
  }

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    while (this.#buffer.byteLength >= 2) {
      const parsed = parseFrame(this.#buffer)
      if (parsed == null) return
      this.#buffer = this.#buffer.subarray(parsed.bytes)
      if (parsed.opcode === 0x8) {
        this.#handlers.close()
        return
      }
      if (parsed.opcode === 0x9) {
        this.#handlers.pong(parsed.payload)
        continue
      }
      if (parsed.opcode !== 0x1) throw new Error('Unsupported WebSocket frame')
      const message = parsed.payload.toString('utf8')
      this.#tail = this.#tail.then(() => this.#handlers.message(message)).catch(() => this.#handlers.close())
    }
  }
}

export const handleInspectorUpgrade = (proxy, request, socket, head) => {
  try {
    const host = request.headers.host ?? '127.0.0.1'
    const url = new URL(request.url ?? '/', `http://${host}`)
    const match = /^\/v1\/inspectors\/([^/]+)\/cdp$/u.exec(url.pathname)
    if (match == null) return rejectUpgrade(socket, 404)
    const key = request.headers['sec-websocket-key']
    if (
      request.headers.upgrade?.toLowerCase() !== 'websocket' || request.headers['sec-websocket-version'] !== '13' ||
      typeof key !== 'string' || Buffer.from(key, 'base64').byteLength !== 16
    ) return rejectUpgrade(socket, 400)
    const inspectorId = decodeURIComponent(match[1])
    const token = url.searchParams.get('access_token')
    const session = proxy.connectAuthorized(inspectorId, token, message => sendJson(socket, message))
    const accept = createHash('sha1').update(`${key}${MAGIC}`).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n'))
    const decoder = new WebSocketFrameDecoder({
      close: () => socket.end(),
      message: async message => sendJson(socket, await session.receive(JSON.parse(message))),
      pong: payload => socket.write(frame(0xA, payload))
    })
    socket.on('data', chunk => {
      try {
        decoder.push(chunk)
      } catch {
        session.close()
        socket.end()
      }
    })
    socket.once('close', session.close)
    socket.once('error', session.close)
    if (head.byteLength > 0) decoder.push(head)
  } catch {
    rejectUpgrade(socket, 401)
  }
}
