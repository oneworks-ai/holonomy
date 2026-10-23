import type { RuntimeEventLoop } from '../event-loop/index.js'

const APPLY = Reflect.apply
const DEFINE = Object.defineProperty
const TYPE_ERROR = TypeError

export type RuntimeImmediateCallback = (...args: unknown[]) => void

export interface RuntimeImmediateHandle {
  hasRef(): boolean
  ref(): RuntimeImmediateHandle
  unref(): RuntimeImmediateHandle
  [Symbol.dispose]?(): void
}

export interface RuntimeImmediateGlobals {
  clearImmediate(handle: unknown): void
  setImmediate(callback: RuntimeImmediateCallback, ...args: unknown[]): RuntimeImmediateHandle
}

export interface RuntimeImmediate extends RuntimeImmediateGlobals {
  dispose(): void
  readonly globals: Readonly<RuntimeImmediateGlobals>
  readonly syntheticModule: Readonly<RuntimeImmediateGlobals>
}

const invalidCallback = (): never => {
  const error = new TYPE_ERROR('The "callback" argument must be of type function')
  DEFINE(error, 'code', { enumerable: true, value: 'ERR_INVALID_ARG_TYPE' })
  throw error
}

/** Owns guest callback/handle identity; the caller-owned loop owns scheduling. */
export const createRuntimeImmediate = (loop: RuntimeEventLoop): RuntimeImmediate => {
  let disposed = false
  const records = new Map<Immediate, number>()

  const clearImmediate = (handle: unknown): void => {
    const taskId = records.get(handle as Immediate)
    if (taskId === undefined) return
    records.delete(handle as Immediate)
    loop.cancelTask(taskId)
  }

  class Immediate implements RuntimeImmediateHandle {
    hasRef(): boolean {
      const taskId = records.get(this)
      return taskId !== undefined && loop.hasRefImmediate(taskId)
    }

    ref(): this {
      const taskId = records.get(this)
      if (taskId !== undefined) loop.refImmediate(taskId)
      return this
    }

    unref(): this {
      const taskId = records.get(this)
      if (taskId !== undefined) loop.unrefImmediate(taskId)
      return this
    }
  }

  const disposeSymbol = Symbol.dispose
  if (typeof disposeSymbol === 'symbol') {
    DEFINE(Immediate.prototype, disposeSymbol, {
      configurable: true,
      value(this: Immediate) {
        clearImmediate(this)
      }
    })
  }

  const setImmediate = (callback: RuntimeImmediateCallback, ...args: unknown[]): RuntimeImmediateHandle => {
    if (disposed) throw new Error('Runtime immediates have been disposed')
    if (typeof callback !== 'function') invalidCallback()
    const handle = new Immediate()
    let completed = false
    const taskId = loop.enqueueImmediate(() => {
      completed = true
      records.delete(handle)
      APPLY(callback, handle, args)
    })
    if (!completed) records.set(handle, taskId)
    return handle
  }

  const globals = Object.freeze({ clearImmediate, setImmediate })
  const unsubscribe = loop.addLifecycleObserver(() => immediate.dispose())
  const immediate: RuntimeImmediate = Object.freeze({
    ...globals,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      const taskIds = [...records.values()]
      records.clear()
      for (const taskId of taskIds) loop.cancelTask(taskId)
    },
    globals,
    syntheticModule: globals
  })
  return immediate
}
