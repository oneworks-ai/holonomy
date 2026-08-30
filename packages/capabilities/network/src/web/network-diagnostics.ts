import { encodeUtf8 } from './utf8.js'

import type { NetworkDiagnosticsEvent, NetworkDiagnosticsSink } from './types.js'

export interface NetworkDiagnosticsBufferLimits {
  maxBytes: number
  maxEvents: number
}

export interface NetworkDiagnosticsSnapshot {
  readonly dropped: number
  readonly events: readonly NetworkDiagnosticsEvent[]
  readonly nextSequence: number
}

interface StoredEvent {
  bytes: number
  event: NetworkDiagnosticsEvent
  sequence: number
}

const DEFAULT_LIMITS: NetworkDiagnosticsBufferLimits = Object.freeze({
  maxBytes: 1024 * 1024,
  maxEvents: 2048
})

const copyEvent = (event: NetworkDiagnosticsEvent) => (
  JSON.parse(JSON.stringify(event)) as NetworkDiagnosticsEvent
)

const validLimit = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0

/** Pull-based diagnostics: a debugger never executes inside the Fetch state machine. */
export class NetworkDiagnosticsBuffer implements NetworkDiagnosticsSink {
  private readonly entries: StoredEvent[] = []
  private readonly limits: Readonly<NetworkDiagnosticsBufferLimits>
  private bytes = 0
  private disposed = false
  private dropped = 0
  private nextSequence = 1

  constructor(limits: Partial<NetworkDiagnosticsBufferLimits> = {}) {
    const resolved = { ...DEFAULT_LIMITS, ...limits }
    if (!validLimit(resolved.maxBytes) || !validLimit(resolved.maxEvents)) {
      throw new TypeError('Invalid network diagnostics limits')
    }
    this.limits = Object.freeze(resolved)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.entries.length = 0
    this.bytes = 0
  }

  emit(event: NetworkDiagnosticsEvent) {
    if (this.disposed) return
    let copy: NetworkDiagnosticsEvent
    let bytes: number
    try {
      copy = copyEvent(event)
      bytes = encodeUtf8(JSON.stringify(copy)).byteLength
    } catch {
      this.dropped += 1
      return
    }
    if (bytes <= 0 || bytes > this.limits.maxBytes) {
      this.dropped += 1
      return
    }
    while (this.entries.length >= this.limits.maxEvents || this.bytes + bytes > this.limits.maxBytes) {
      const removed = this.entries.shift()
      if (removed == null) break
      this.bytes -= removed.bytes
      this.dropped += 1
    }
    this.entries.push({ bytes, event: copy, sequence: this.nextSequence++ })
    this.bytes += bytes
  }

  snapshot(after = 0, limit = this.limits.maxEvents): NetworkDiagnosticsSnapshot {
    if (!Number.isSafeInteger(after) || after < 0 || !validLimit(limit)) {
      throw new TypeError('Invalid network diagnostics cursor')
    }
    const events = this.entries
      .filter(entry => entry.sequence > after)
      .slice(0, limit)
      .map(entry => copyEvent(entry.event))
    return Object.freeze({
      dropped: this.dropped,
      events: Object.freeze(events),
      nextSequence: this.nextSequence
    })
  }
}

export const emitNetworkDiagnostic = (
  sink: NetworkDiagnosticsSink | undefined,
  event: NetworkDiagnosticsEvent
) => {
  if (sink == null) return
  try {
    sink.emit(event)
  } catch {
    // Diagnostics is a lossy side channel and never participates in Fetch.
  }
}
