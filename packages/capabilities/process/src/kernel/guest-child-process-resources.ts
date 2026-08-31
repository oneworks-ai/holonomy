import type { CapabilityGuestBridgeV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import {
  capabilityResourceFieldsV1,
  createCapabilityRequestV1,
  readCapabilityResourceEventV1,
  readCapabilityTerminalV1
} from '@holonomyjs/runtime/kernel/guest-facade-support'
import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import {
  childProcessCallbackV1,
  childProcessInvalidStateV1,
  childProcessRecordV1,
  invalidChildProcessValueV1
} from './guest-child-process-support.js'

type Listener = (...args: unknown[]) => unknown
type Fields = Readonly<Record<string, JsonValueV1>>

const scheduleCallback = (callback: () => void) => {
  void Promise.resolve().then(callback)
}

const errorFrom = (value: unknown) => {
  const source = childProcessRecordV1(value)
  const error = new Error(typeof source.message === 'string' ? source.message : 'Controlled child process failed')
  error.name = typeof source.name === 'string' ? source.name : 'Error'
  if (typeof source.code === 'string') Object.defineProperty(error, 'code', { enumerable: true, value: source.code })
  return error
}
const emit = (listeners: Map<string, Set<Listener>>, event: string, ...args: unknown[]) => {
  for (const listener of listeners.get(event) ?? []) {
    try {
      listener(...args)
    } catch {
      // Event listeners never affect the Host resource state machine.
    }
  }
}
const eventTarget = (listeners: Map<string, Set<Listener>>, target: Record<string, unknown>) => {
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

export const createChildProcessResourceFactoryV1 = (bridge: CapabilityGuestBridgeV1) => {
  const sync = (member: string, args: JsonValueV1, fields: Fields) =>
    readCapabilityTerminalV1(
      bridge.invokeSync(createCapabilityRequestV1('node:child_process', member, 'sync', args, fields))
    )
  const immediate = (member: string, args: JsonValueV1, fields: Fields, callbackId?: number) =>
    readCapabilityTerminalV1(
      bridge.invokeImmediate!(createCapabilityRequestV1(
        'node:child_process',
        member,
        'callback',
        args,
        callbackId == null ? fields : { ...fields, providerData: { callbackId } }
      ))
    )
  const readable = (snapshot: unknown) => {
    if (snapshot == null) return null
    const fields = capabilityResourceFieldsV1(snapshot, 'process.readable')
    const listeners = new Map<string, Set<Listener>>()
    const api = eventTarget(listeners, Object.create(null) as Record<string, unknown>)
    bridge.subscribeResource?.(fields.bindingId, source => {
      const event = childProcessRecordV1(readCapabilityResourceEventV1(source))
      const tuple = Array.isArray(event.tuple) ? event.tuple : []
      emit(listeners, String(event.event), ...(event.event === 'error' ? [errorFrom(tuple[0])] : tuple))
    })
    api.destroy = () => {
      sync('stdout/stderr.destroy', {}, fields)
      return api
    }
    api.pause = () => {
      sync('stdout/stderr.pause', {}, fields)
      return api
    }
    api.resume = () => {
      sync('stdout/stderr.resume', {}, fields)
      return api
    }
    return Object.freeze(api)
  }
  const stdin = (snapshot: unknown) => {
    if (snapshot == null) return null
    const fields = capabilityResourceFieldsV1(snapshot, 'process.stdin')
    const callbacks = new Map<number, Listener>()
    let closed = false
    let destroyed = false
    let ended = false
    let nextCallbackId = 0
    let dispose = () => {}
    const register = (done: unknown) => {
      if (done == null) return undefined
      const callbackId = ++nextCallbackId
      callbacks.set(callbackId, childProcessCallbackV1(done))
      return callbackId
    }
    const forget = (callbackId: number | undefined) => {
      if (callbackId != null) callbacks.delete(callbackId)
    }
    const settle = (callbackId: unknown, error: unknown) => {
      if (!Number.isSafeInteger(callbackId) || (callbackId as number) < 1) return
      const callback = callbacks.get(callbackId as number)
      if (callback == null) return
      callbacks.delete(callbackId as number)
      scheduleCallback(() => callback(error == null ? null : errorFrom(error)))
    }
    const api: Record<string, unknown> = Object.create(null)
    api.destroy = () => {
      if (destroyed) return api
      destroyed = true
      ended = true
      sync('ChildProcess.stdin.destroy', {}, fields)
      return api
    }
    api.end = (done?: unknown) => {
      if (ended || closed || destroyed) {
        if (done != null) scheduleCallback(() => childProcessCallbackV1(done)(null))
        return api
      }
      const callbackId = register(done)
      try {
        immediate('ChildProcess.stdin.end', {}, fields, callbackId)
        ended = true
      } catch (error) {
        forget(callbackId)
        throw error
      }
      return api
    }
    api.write = (data: unknown, done?: unknown) => {
      if (ended || closed || destroyed) throw childProcessInvalidStateV1()
      const callbackId = register(done)
      try {
        return immediate('ChildProcess.stdin.write', data as JsonValueV1, fields, callbackId)
      } catch (error) {
        forget(callbackId)
        throw error
      }
    }
    dispose = bridge.subscribeResource?.(fields.bindingId as string, source => {
      const event = childProcessRecordV1(readCapabilityResourceEventV1(source))
      if (event.event === 'callback') settle(event.callbackId, event.error)
      if (event.event === 'close') {
        closed = true
        ended = true
        const error = childProcessInvalidStateV1()
        for (const callbackId of [...callbacks.keys()]) settle(callbackId, error)
        dispose()
      }
    }) ?? dispose
    return Object.freeze(api)
  }
  return (snapshot: unknown) => {
    const source = childProcessRecordV1(snapshot)
    const fields = capabilityResourceFieldsV1(source, 'process.child')
    const nestedBindingIds = [
      source.stdin == null ? undefined : capabilityResourceFieldsV1(source.stdin, 'process.stdin').bindingId,
      source.stdout == null ? undefined : capabilityResourceFieldsV1(source.stdout, 'process.readable').bindingId,
      source.stderr == null ? undefined : capabilityResourceFieldsV1(source.stderr, 'process.readable').bindingId
    ].filter((value): value is string => value != null)
    const listeners = new Map<string, Set<Listener>>()
    const api = eventTarget(listeners, Object.create(null) as Record<string, unknown>)
    Object.assign(api, {
      kill: (signal: unknown = 'SIGTERM') => sync('ChildProcess.kill', signal as JsonValueV1, fields),
      pid: source.pid,
      stderr: readable(source.stderr),
      stdin: stdin(source.stdin),
      stdout: readable(source.stdout)
    })
    bridge.subscribeResource?.(fields.bindingId, eventSource => {
      const event = childProcessRecordV1(readCapabilityResourceEventV1(eventSource))
      const tuple = Array.isArray(event.tuple) ? event.tuple : []
      emit(listeners, String(event.event), ...(event.event === 'error' ? [errorFrom(tuple[0])] : tuple))
      if (event.event === 'close') {
        for (const bindingId of nestedBindingIds) bridge.releaseResource?.(bindingId)
        bridge.releaseResource?.(fields.bindingId)
      }
    })
    return Object.freeze(api)
  }
}
