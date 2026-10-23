// This adapter stays inside the private Host Control bundle. The native entry
// is absent from Guest and does not register a Process Provider.
export const createNativeV86HostPort = native => {
  if (typeof native.v86 !== 'function') return undefined
  const opened = new Map()
  let disposed = false
  const send = (kind, fields = {}) => {
    if (disposed) throw new Error('Native VM port is closed')
    const result = JSON.parse(native.v86(JSON.stringify({ schemaVersion: 1, kind, ...fields })))
    if (result.schemaVersion !== 1 || result.ok !== true) {
      throw new Error(`Native VM ${result.code ?? 'protocol_error'}`)
    }
    return result.value
  }
  return Object.freeze({
    install: ({ root, bios, kernel, initrd, wasmSha256 }) =>
      send('install', { root, bios, kernel, initrd, wasmSha256 }),
    open: ({ id, generation, memoryBytes }) => {
      const value = send('open', { id, generation, memoryBytes })
      opened.set(id, generation)
      return value
    },
    start: ({ id, generation }) => send('start', { id, generation }),
    serialWrite: ({ id, generation, uart, base64 }) => send('serialWrite', { id, generation, uart, base64 }),
    drain: ({ id, generation, maxBytes }) => send('drain', { id, generation, maxBytes }),
    poll: ({ id, generation }) => send('poll', { id, generation }),
    drainEvents: (limit = 32) => send('drainEvents', { limit }),
    close: ({ id, generation }) => {
      const value = send('close', { id, generation })
      opened.delete(id)
      return value
    },
    dispose: () => {
      if (disposed) return
      for (const [id, generation] of opened) {
        try {
          send('close', { id, generation })
        } catch { /* native ControlState drop is the backstop */ }
      }
      opened.clear()
      disposed = true
    }
  })
}
