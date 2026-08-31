import process from 'node:process'

export const createV86ProbeTraceV1 = ImportedV86 => {
  let tail = ''
  class ProbeV86 extends ImportedV86 {
    constructor(options) {
      super(options)
      this.add_listener('serial0-output-byte', byte => {
        const value = String.fromCharCode(byte)
        tail = (tail + value).slice(-16_384)
        if (process.env.HOLO_V86_TRACE === '1') process.stderr.write(value)
      })
      if (process.env.HOLO_V86_TRACE !== '1') return
      this.add_listener('serial1-output-byte', byte => {
        process.stderr.write(byte.toString(16).padStart(2, '0'))
      })
      for (const event of ['emulator-ready', 'emulator-started', 'download-error']) {
        this.add_listener(event, () => process.stderr.write(`[v86:${event}]\n`))
      }
    }
  }
  return Object.freeze({
    serial0Tail: () => tail,
    V86: ProbeV86
  })
}
