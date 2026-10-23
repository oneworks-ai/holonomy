import {
  childProcessCallbackV1,
  childProcessRecordV1,
  invalidChildProcessValueV1
} from './guest-child-process-support.js'

type Listener = (...args: unknown[]) => unknown
type ListenerRecord = Readonly<{ listener: Listener; original: Listener }>
export type ChildProcessListeners = Map<string, ListenerRecord[]>

export const childProcessListeners = (): ChildProcessListeners => new Map()

const eventName = (event: unknown): string => {
  if (typeof event !== 'string') return invalidChildProcessValueV1('Process event name must be a string')
  return event
}

const callback = (listener: unknown): Listener => childProcessCallbackV1(listener)

const remove = (listeners: ChildProcessListeners, event: string, listener: Listener) => {
  const records = listeners.get(event)
  if (records == null) return
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!
    if (record.listener === listener || record.original === listener) {
      records.splice(index, 1)
      break
    }
  }
  if (records.length === 0) listeners.delete(event)
}

export const errorFrom = (value: unknown) => {
  const source = childProcessRecordV1(value)
  const error = new Error(typeof source.message === 'string' ? source.message : 'Controlled child process failed')
  error.name = typeof source.name === 'string' ? source.name : 'Error'
  if (typeof source.code === 'string') Object.defineProperty(error, 'code', { enumerable: true, value: source.code })
  return error
}

export const emit = (
  listeners: ChildProcessListeners,
  target: Record<string, unknown>,
  event: string,
  ...args: unknown[]
) => {
  // A delivery observes the records present when it starts. Reentrant additions
  // wait for the next delivery, while removals do not mutate this snapshot.
  for (const record of [...(listeners.get(event) ?? [])]) {
    try {
      Reflect.apply(record.listener, target, args)
    } catch {
      // Event listeners never affect the Host resource state machine.
    }
  }
}

export const clearListeners = (listeners: ChildProcessListeners) => listeners.clear()

export const eventTarget = (listeners: ChildProcessListeners, target: Record<string, unknown>) => {
  target.on = (event: unknown, listener: unknown) => {
    const name = eventName(event)
    const accepted = callback(listener)
    let entries = listeners.get(name)
    if (entries == null) {
      entries = []
      listeners.set(name, entries)
    }
    entries.push({ listener: accepted, original: accepted })
    return target
  }
  target.addListener = target.on
  target.once = (event: unknown, listener: unknown) => {
    const name = eventName(event)
    const accepted = callback(listener)
    let fired = false
    const wrapped = (...args: unknown[]) => {
      if (fired) return
      fired = true
      remove(listeners, name, wrapped)
      Reflect.apply(accepted, target, args)
    }
    let entries = listeners.get(name)
    if (entries == null) {
      entries = []
      listeners.set(name, entries)
    }
    entries.push({ listener: wrapped, original: accepted })
    return target
  }
  target.off = (event: unknown, listener: unknown) => {
    remove(listeners, eventName(event), callback(listener))
    return target
  }
  target.removeListener = target.off
  target.removeAllListeners = (event?: unknown) => {
    if (event === undefined) listeners.clear()
    else listeners.delete(eventName(event))
    return target
  }
  target.listenerCount = (event: unknown, listener?: unknown) => {
    const entries = listeners.get(eventName(event)) ?? []
    if (listener === undefined) return entries.length
    const accepted = callback(listener)
    return entries.filter(entry => entry.original === accepted).length
  }
  target.listeners = (event: unknown) => [...(listeners.get(eventName(event)) ?? [])].map(entry => entry.original)
  target.eventNames = () => [...listeners.keys()]
  return target
}
