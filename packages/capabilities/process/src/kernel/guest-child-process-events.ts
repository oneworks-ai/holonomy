import {
  childProcessCallbackV1,
  childProcessRecordV1,
  invalidChildProcessValueV1
} from './guest-child-process-support.js'

type Listener = (...args: unknown[]) => unknown

export const errorFrom = (value: unknown) => {
  const source = childProcessRecordV1(value)
  const error = new Error(typeof source.message === 'string' ? source.message : 'Controlled child process failed')
  error.name = typeof source.name === 'string' ? source.name : 'Error'
  if (typeof source.code === 'string') Object.defineProperty(error, 'code', { enumerable: true, value: source.code })
  return error
}

export const emit = (listeners: Map<string, Set<Listener>>, event: string, ...args: unknown[]) => {
  for (const listener of listeners.get(event) ?? []) {
    try {
      listener(...args)
    } catch {
      // Event listeners never affect the Host resource state machine.
    }
  }
}

export const eventTarget = (listeners: Map<string, Set<Listener>>, target: Record<string, unknown>) => {
  target.on = (event: unknown, listener: unknown) => {
    if (typeof event !== 'string') return invalidChildProcessValueV1('Process event name must be a string')
    const accepted = childProcessCallbackV1(listener)
    let entries = listeners.get(event)
    if (entries == null) {
      entries = new Set()
      listeners.set(event, entries)
    }
    entries.add(accepted)
    return target
  }
  target.once = (event: unknown, listener: unknown) => {
    const accepted = childProcessCallbackV1(listener)
    const wrapped = (...args: unknown[]) => {
      listeners.get(String(event))?.delete(wrapped)
      accepted(...args)
    }
    return (target.on as Function)(event, wrapped)
  }
  return target
}
