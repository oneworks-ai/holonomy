import { Buffer } from 'node:buffer'

const MAX_DIAGNOSTIC_BYTES = 256 * 1024

export const ingestNetworkOutput = (proxy, process, events) => {
  const visible = []
  for (const event of events) {
    if (event.stream !== 'network') {
      visible.push(event)
      continue
    }
    try {
      const chunk = event.chunk
      if (typeof chunk !== 'string' || Buffer.byteLength(chunk) > MAX_DIAGNOSTIC_BYTES) continue
      proxy.emitDiagnostic(process.id, process.generation, JSON.parse(chunk))
    } catch {
      // Malformed diagnostics are dropped and never rendered as stdout/stderr.
    }
  }
  return visible
}
