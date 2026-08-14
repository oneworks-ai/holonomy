import { Buffer } from 'node:buffer'

const invalid = () => {
  throw new TypeError('Invalid Process supervisor payload')
}

const writer = () => {
  const parts = []
  return {
    bytes(value) {
      parts.push(Buffer.from(value))
    },
    finish() {
      return Uint8Array.from(Buffer.concat(parts))
    },
    string(value) {
      if (typeof value !== 'string' || value.includes('\0')) return invalid()
      const bytes = Buffer.from(value)
      const length = Buffer.allocUnsafe(4)
      length.writeUInt32BE(bytes.length)
      parts.push(length, bytes)
    },
    u16(value) {
      if (!Number.isInteger(value) || value < 0 || value > 0xFFFF) return invalid()
      const bytes = Buffer.allocUnsafe(2)
      bytes.writeUInt16BE(value)
      parts.push(bytes)
    }
  }
}

const reader = value => {
  if (!(value instanceof Uint8Array)) return invalid()
  const bytes = Buffer.from(value)
  let offset = 0
  return {
    done() {
      if (offset !== bytes.length) return invalid()
    },
    i32() {
      if (offset + 4 > bytes.length) return invalid()
      const output = bytes.readInt32BE(offset)
      offset += 4
      return output
    },
    string() {
      if (offset + 4 > bytes.length) return invalid()
      const length = bytes.readUInt32BE(offset)
      offset += 4
      if (offset + length > bytes.length) return invalid()
      const source = bytes.subarray(offset, offset + length)
      const output = source.toString('utf8')
      if (!Buffer.from(output).equals(source) || output.includes('\0')) return invalid()
      offset += length
      return output
    }
  }
}

export const emptyPayload = value => {
  if (!(value instanceof Uint8Array) || value.byteLength !== 0) return invalid()
}

export const completionPayload = value => {
  const input = reader(value)
  const code = input.i32()
  const signal = input.string()
  input.done()
  if (code < -1 || code > 255 || signal !== '' && !/^SIG[A-Z\d]{1,24}$/u.test(signal)) return invalid()
  return { code: code === -1 ? null : code, signal: signal === '' ? null : signal }
}

export const encodeCompletionPayload = (code, signal) => {
  const output = Buffer.allocUnsafe(4)
  output.writeInt32BE(code ?? -1)
  const tail = writer()
  tail.string(signal ?? '')
  return Uint8Array.from(Buffer.concat([output, tail.finish()]))
}

export const errorPayload = value => {
  const input = reader(value)
  const code = input.string()
  input.done()
  if (!/^[a-z][a-z\d_.-]{0,63}$/u.test(code)) return invalid()
  const error = new Error('Process supervisor operation failed')
  Object.defineProperty(error, 'code', { enumerable: true, value: code })
  return error
}

export const encodeSignalPayload = signal => {
  if (typeof signal !== 'string' || !/^SIG[A-Z\d]{1,24}$/u.test(signal)) return invalid()
  const output = writer()
  output.string(signal)
  return output.finish()
}

export const encodeSpawnedPayload = linuxPid => {
  if (!Number.isInteger(linuxPid) || linuxPid <= 0 || linuxPid > 0x7FFF_FFFF) return invalid()
  const output = Buffer.allocUnsafe(4)
  output.writeInt32BE(linuxPid)
  return Uint8Array.from(output)
}

export const encodeSpawnPayload = request => {
  if (request.executable?.kind !== 'guestPath' || !Array.isArray(request.stdio) || request.stdio.length !== 3) {
    return invalid()
  }
  const entries = Object.entries(request.env).sort(([left], [right]) => left < right ? -1 : 1)
  if (request.args.length > 0xFFFF || entries.length > 0xFFFF) return invalid()
  const output = writer()
  output.bytes(Uint8Array.of(
    1,
    request.stdio.reduce((mask, mode, index) => mode === 'pipe' ? mask | (1 << index) : mask, 0),
    0,
    0
  ))
  for (
    const value of [
      request.executable.path,
      request.cwd,
      request.executableId,
      request.processResourceId
    ]
  ) output.string(value)
  output.u16(request.args.length)
  output.u16(entries.length)
  for (const value of request.args) output.string(value)
  for (const [key, value] of entries) {
    output.string(key)
    output.string(value)
  }
  return output.finish()
}

export const spawnedPayload = (value, frameProcessId) => {
  if (!Number.isInteger(frameProcessId) || frameProcessId <= 0) return invalid()
  const input = reader(value)
  const linuxPid = input.i32()
  input.done()
  if (linuxPid <= 0) return invalid()
  return { linuxPid, processId: frameProcessId }
}
