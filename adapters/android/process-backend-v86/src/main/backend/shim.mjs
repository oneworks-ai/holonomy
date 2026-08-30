;(() => {
  const timers = new Map()
  let nextTimerId = 1
  let randomState = 0x6D2B79F5
  const ascii = bytes => {
    let output = ''
    for (const byte of bytes) output += String.fromCharCode(byte)
    return output
  }
  const bytes = value => {
    const output = new Uint8Array(value.length)
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index)
      if (code > 0x7F) throw new TypeError('The v86 Backend protocol is ASCII-only')
      output[index] = code
    }
    return output
  }
  const encodeUtf8 = (input, destination) => {
    let read = 0
    let written = 0
    const write = byte => {
      if (destination != null) destination[written] = byte
      written += 1
    }
    while (read < input.length) {
      const first = input.charCodeAt(read)
      let codePoint = first
      let codeUnits = 1
      if (first >= 0xD800 && first <= 0xDBFF && read + 1 < input.length) {
        const second = input.charCodeAt(read + 1)
        if (second >= 0xDC00 && second <= 0xDFFF) {
          codePoint = 0x10000 + ((first - 0xD800) << 10) + second - 0xDC00
          codeUnits = 2
        } else {
          codePoint = 0xFFFD
        }
      } else if (first >= 0xD800 && first <= 0xDFFF) {
        codePoint = 0xFFFD
      }
      const required = codePoint <= 0x7F ? 1 : codePoint <= 0x7FF ? 2 : codePoint <= 0xFFFF ? 3 : 4
      if (destination != null && written + required > destination.length) break
      if (required === 1) {
        write(codePoint)
      } else if (required === 2) {
        write(0xC0 | (codePoint >> 6))
        write(0x80 | (codePoint & 0x3F))
      } else if (required === 3) {
        write(0xE0 | (codePoint >> 12))
        write(0x80 | ((codePoint >> 6) & 0x3F))
        write(0x80 | (codePoint & 0x3F))
      } else {
        write(0xF0 | (codePoint >> 18))
        write(0x80 | ((codePoint >> 12) & 0x3F))
        write(0x80 | ((codePoint >> 6) & 0x3F))
        write(0x80 | (codePoint & 0x3F))
      }
      read += codeUnits
    }
    return { read, written }
  }
  globalThis.console = Object.freeze({
    assert(value) {
      if (!value) throw new Error('v86 assertion failed')
    },
    debug() {},
    error() {},
    log() {},
    trace() {},
    warn() {}
  })
  globalThis.performance = Object.freeze({ now: () => Date.now() })
  globalThis.crypto = Object.freeze({
    getRandomValues(output) {
      const view = new Uint8Array(output.buffer, output.byteOffset, output.byteLength)
      for (let index = 0; index < view.length; index += 1) {
        randomState ^= randomState << 13
        randomState ^= randomState >>> 17
        randomState ^= randomState << 5
        view[index] = randomState & 0xFF
      }
      return output
    }
  })
  globalThis.TextDecoder = class {
    decode(input = new Uint8Array()) {
      return ascii(input instanceof Uint8Array ? input : new Uint8Array(input))
    }
  }
  globalThis.TextEncoder = class {
    get encoding() {
      return 'utf-8'
    }
    encode(input = '') {
      const value = String(input)
      const size = encodeUtf8(value).written
      const output = new Uint8Array(size)
      encodeUtf8(value, output)
      return output
    }
    encodeInto(input, destination) {
      if (!(destination instanceof Uint8Array)) throw new TypeError('TextEncoder destination must be Uint8Array')
      return encodeUtf8(String(input), destination)
    }
  }
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const id = nextTimerId++
    timers.set(id, { args, callback, deadline: Date.now() + Math.max(0, Number(delay) || 0) })
    return id
  }
  globalThis.clearTimeout = id => timers.delete(id)
  globalThis.__holoRunV86Timers = () => {
    const now = Date.now()
    const due = [...timers]
      .filter(([, timer]) => timer.deadline <= now)
      .sort(([left], [right]) => left - right)
    for (const [id, timer] of due) {
      if (!timers.delete(id)) continue
      timer.callback(...timer.args)
    }
    return due.length
  }
  globalThis.__holoV86ProbeSupport = Object.freeze({ ascii, bytes })
})()
