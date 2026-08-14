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
      if (code > 0x7F) throw new TypeError('The v86 probe protocol is ASCII-only')
      output[index] = code
    }
    return output
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
    encode(input = '') {
      return bytes(String(input))
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
