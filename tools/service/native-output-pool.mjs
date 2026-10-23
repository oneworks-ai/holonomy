import { Buffer } from 'node:buffer'

/** Native adapter staging only; the existing ServiceLogStore remains durable owner. */
export class NativeOutputPool {
  #entries = new Map()
  #bytes = 0
  #limits
  constructor(limits = {}) {
    this.#limits = {
      maxBytes: 16 * 1024 * 1024,
      maxRecordBytes: 2 * 1024 * 1024,
      maxEvents: 8192,
      maxRecordEvents: 1024,
      ...limits
    }
  }
  get snapshot() {
    return { bytes: this.#bytes, events: this.#entries.size }
  }

  append(record, stream, chunk) {
    if (record.outputRetired) return
    const event = Object.freeze({ chunk, sequence: record.nextSequence++, stream })
    const bytes = Buffer.byteLength(chunk, 'utf8') + 64
    if (bytes > this.#limits.maxRecordBytes || bytes > this.#limits.maxBytes) return
    while (
      record.logs.length > 0 &&
      ((record.logBytes ?? 0) + bytes > this.#limits.maxRecordBytes ||
        record.logs.length >= this.#limits.maxRecordEvents)
    ) {
      this.#evict(record.logs[0])
    }
    while (
      this.#entries.size > 0 &&
      (this.#bytes + bytes > this.#limits.maxBytes || this.#entries.size >= this.#limits.maxEvents)
    ) {
      this.#evict(this.#entries.keys().next().value)
    }
    this.#entries.set(event, { bytes, record })
    record.logs.push(event)
    record.logBytes = (record.logBytes ?? 0) + bytes
    this.#bytes += bytes
  }

  page(record, after, limit) {
    const events = []
    const first = record.logs[0]?.sequence ?? record.nextSequence
    if (first > after + 1 && limit > 0) {
      events.push({
        sequence: first - 1,
        stream: 'stderr',
        chunk: `[Holonomy Native output dropped ${first - after - 1} source events]\n`
      })
    }
    let bytes = 128 + events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8') + 1, 0)
    for (const event of record.logs) {
      if (event.sequence <= after) continue
      const cost = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
      if (events.length >= limit || bytes + cost > 512 * 1024) break
      bytes += cost
      events.push(event)
    }
    return { cursor: events.at(-1)?.sequence ?? after, events }
  }

  release(record) {
    record.outputRetired = true
    while (record.logs.length > 0) this.#evict(record.logs[0])
  }

  #evict(event) {
    const entry = this.#entries.get(event)
    if (entry == null) return
    this.#entries.delete(event)
    entry.record.logs.shift()
    entry.record.logBytes -= entry.bytes
    this.#bytes -= entry.bytes
  }
}
