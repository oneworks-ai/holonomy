/** A settlement lease, not another invocation or cancellation controller. */
export const createBrokerFrameLeaseV1 = () => {
  const active = new Set<Promise<unknown>>()
  let closed = false
  let settle!: () => void
  const settled = new Promise<void>(resolve => {
    settle = resolve
  })
  const maybeSettle = () => {
    if (closed && active.size === 0) settle()
  }
  return Object.freeze({
    close: () => {
      closed = true
      maybeSettle()
    },
    get closed() {
      return closed
    },
    get pending() {
      return active.size > 0
    },
    settled,
    track: <T>(task: Promise<T>): Promise<T> => {
      if (active.has(task)) return task
      active.add(task)
      const release = () => {
        active.delete(task)
        maybeSettle()
      }
      // Observe both paths even when next() or a Provider Promise is ignored.
      void task.then(release, release)
      return task
    }
  })
}

export type BrokerFrameLeaseV1 = ReturnType<typeof createBrokerFrameLeaseV1>
