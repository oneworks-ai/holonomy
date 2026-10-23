import { utf8ByteLength } from '../../../../packages/runtime/src/kernel/validation.ts'

// Must fit the native Control result envelope. Limit encoded bytes, not raw
// binary lengths: base64, JSON escaping and UTF-8 all contribute to transport.
export const MAX_CONTROL_EVENT_BATCH_BYTES = 64 * 1024 * 1024

export const drainNativeEventBatch = (queue, maxBytes = MAX_CONTROL_EVENT_BATCH_BYTES) => {
  const encoded = []
  // Reserve a conservative bound for keys, brackets, commas and remaining count.
  let bytes = 64
  for (let index = 0; index < Math.min(queue.length, 64); index++) {
    const event = JSON.stringify(queue[index])
    const size = utf8ByteLength(event) + 1
    if (size + 64 > maxBytes) throw new Error('Native event exceeds transport limit')
    if (bytes + size > maxBytes) break
    bytes += size
    encoded.push(event)
  }
  const result = `{"events":[${encoded.join(',')}],"remaining":${queue.length - encoded.length}}`
  if (utf8ByteLength(result) > maxBytes) throw new Error('Native event batch exceeds transport limit')
  // Dequeue only after the exact transfer string has passed its bound.
  queue.splice(0, encoded.length)
  return result
}
