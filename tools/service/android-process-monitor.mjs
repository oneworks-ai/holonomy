const TERMINAL_PHASES = new Map([
  ['canceled', 'cancelled'],
  ['completed', 'exited'],
  ['disposed', 'cancelled'],
  ['failed', 'failed'],
  ['stopped', 'cancelled']
])

const publishTerminal = (record, terminal) => {
  if (record.terminal != null || record.stopping) return
  record.terminal = Object.freeze(terminal)
  for (const listener of [...record.terminalListeners]) {
    try {
      listener(record.terminal)
    } catch {
      record.terminalListeners.delete(listener)
    }
  }
}

export const observeAndroidReply = (record, reply) => {
  if (reply?.ack?.generation != null) record.generation = reply.ack.generation
  const state = TERMINAL_PHASES.get(reply?.state?.phase)
  if (state == null) return
  const code = Number.isSafeInteger(reply.result?.exitCode)
    ? Math.max(0, Math.min(255, reply.result.exitCode))
    : state === 'exited'
    ? 0
    : 1
  publishTerminal(record, {
    exit: { code, reason: state === 'exited' ? 'completed' : state },
    generation: record.processGeneration,
    state
  })
}

const schedulePoll = (record, commandPort, process, options) => {
  if (record.pollTimer != null || record.terminal != null || record.terminalListeners.size === 0) return
  record.pollTimer = options.setTimer(() => {
    record.pollTimer = undefined
    void commandPort.command(record.serial, {
      command: 'status',
      expectedGeneration: record.generation,
      runtimeId: process.id
    }).then(reply => {
      record.pollFailures = 0
      observeAndroidReply(record, reply)
    }, () => {
      record.pollFailures += 1
      if (record.pollFailures >= options.maxFailures) {
        publishTerminal(record, {
          exit: { code: 1, reason: 'lost' },
          generation: record.processGeneration,
          state: 'lost'
        })
      }
    }).finally(() => schedulePoll(record, commandPort, process, options))
  }, options.pollIntervalMs)
  record.pollTimer?.unref?.()
}

export const subscribeAndroidProcess = (record, commandPort, process, onTerminal, options = {}) => {
  record.terminalListeners.add(onTerminal)
  if (record.terminal != null) queueMicrotask(() => onTerminal(record.terminal))
  else {
    schedulePoll(record, commandPort, process, {
      maxFailures: options.maxFailures ?? 3,
      pollIntervalMs: options.pollIntervalMs ?? 250,
      setTimer: options.setTimer ?? setTimeout
    })
  }
  return () => {
    record.terminalListeners.delete(onTerminal)
    if (record.terminalListeners.size > 0 || record.pollTimer == null) return
    clearTimeout(record.pollTimer)
    record.pollTimer = undefined
  }
}

export const stopAndroidProcessMonitor = record => {
  record.stopping = true
  if (record.pollTimer != null) clearTimeout(record.pollTimer)
  record.pollTimer = undefined
  record.terminalListeners.clear()
}
