import { UnhandledErrorEventError, invalidArgument } from './errors.js'

export type NodeEventName = string | symbol
export type NodeEventListener = (...args: any[]) => void

interface ListenerRecord {
  listener: NodeEventListener
  original: NodeEventListener
  once: boolean
}

const DEFAULT_MAX_LISTENERS = 10

export class EventEmitter {
  private readonly events = new Map<NodeEventName, ListenerRecord[]>()
  private maxListeners = DEFAULT_MAX_LISTENERS

  addListener(eventName: NodeEventName, listener: NodeEventListener): this {
    return this.on(eventName, listener)
  }

  on(eventName: NodeEventName, listener: NodeEventListener): this {
    this.assertListener(listener)
    const records = this.events.get(eventName) ?? []
    records.push({ listener, once: false, original: listener })
    this.events.set(eventName, records)
    return this
  }

  once(eventName: NodeEventName, listener: NodeEventListener): this {
    this.assertListener(listener)
    const wrapper: NodeEventListener = (...args) => {
      this.removeListener(eventName, wrapper)
      Reflect.apply(listener, this, args)
    }
    const records = this.events.get(eventName) ?? []
    records.push({ listener: wrapper, once: true, original: listener })
    this.events.set(eventName, records)
    return this
  }

  off(eventName: NodeEventName, listener: NodeEventListener): this {
    return this.removeListener(eventName, listener)
  }

  removeListener(eventName: NodeEventName, listener: NodeEventListener): this {
    this.assertListener(listener)
    const records = this.events.get(eventName)
    if (!records) {
      return this
    }
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]!
      if (record.listener === listener || record.original === listener) {
        records.splice(index, 1)
        break
      }
    }
    if (records.length === 0) {
      this.events.delete(eventName)
    }
    return this
  }

  removeAllListeners(eventName?: NodeEventName): this {
    if (eventName === undefined) {
      this.events.clear()
    } else {
      this.events.delete(eventName)
    }
    return this
  }

  emit(eventName: NodeEventName, ...args: unknown[]): boolean {
    const records = this.events.get(eventName)
    if (!records || records.length === 0) {
      if (eventName === 'error') {
        const error = args[0]
        if (error instanceof Error) {
          throw error
        }
        throw new UnhandledErrorEventError(error)
      }
      return false
    }
    for (const record of [...records]) {
      if (record.once && this.hasRecord(eventName, record)) {
        this.removeListener(eventName, record.listener)
      }
      Reflect.apply(record.original, this, args)
    }
    return true
  }

  listeners(eventName: NodeEventName): NodeEventListener[] {
    return (this.events.get(eventName) ?? []).map(record => record.original)
  }

  listenerCount(
    eventName: NodeEventName,
    listener?: NodeEventListener
  ): number {
    const records = this.events.get(eventName) ?? []
    if (listener === undefined) {
      return records.length
    }
    this.assertListener(listener)
    return records.filter(record => record.original === listener).length
  }

  setMaxListeners(count: number): this {
    if (typeof count !== 'number' || Number.isNaN(count) || count < 0) {
      invalidArgument(
        'count',
        'EventEmitter max listeners must be a non-negative number'
      )
    }
    this.maxListeners = count
    return this
  }

  getMaxListeners(): number {
    return this.maxListeners
  }

  private assertListener(listener: NodeEventListener): void {
    if (typeof listener !== 'function') {
      invalidArgument('listener', 'EventEmitter listener must be a function')
    }
  }

  private hasRecord(eventName: NodeEventName, record: ListenerRecord): boolean {
    return this.events.get(eventName)?.includes(record) ?? false
  }
}

export interface EventsSyntheticModule {
  readonly default: typeof EventEmitter
  readonly EventEmitter: typeof EventEmitter
}

export const createEventsSyntheticModule = (): EventsSyntheticModule => {
  return Object.freeze({ default: EventEmitter, EventEmitter })
}
