const MAX_EVENTS = 256
const MAX_BYTES = 256 * 1024

// A port may emit before spawn returns. Stage only a bounded prefix, then
// replay after the Process resource has been admitted to the shared ledger.
export const createPreReadyProcessSinkV1 = sink => {
  const queued = []
  let bytes = 0
  let overflow = false
  let ready = false
  const portSink = Object.freeze(Object.fromEntries(
    Object.keys(sink).map(name => [name, (...values) => {
      if (ready) return sink[name](...values)
      if (overflow) return
      const count = name === 'stdout' || name === 'stderr' ? values[0]?.byteLength : 0
      if (
        !Number.isSafeInteger(count) || count < 0 ||
        queued.length >= MAX_EVENTS || bytes + count > MAX_BYTES
      ) {
        overflow = true
        queued.length = 0
        return
      }
      bytes += count
      queued.push([name, values])
    }])
  ))
  return Object.freeze({
    portSink,
    overflow: () => overflow,
    replay() {
      ready = true
      for (const [name, values] of queued) sink[name](...values)
      queued.length = 0
    }
  })
}
