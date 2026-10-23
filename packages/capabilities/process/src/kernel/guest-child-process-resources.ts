/* eslint-disable max-lines -- Guest child resources share one ordered event owner. */
import type { CapabilityGuestBridgeV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import {
  capabilityResourceFieldsV1,
  createCapabilityRequestV1,
  readCapabilityResourceEventV1,
  readCapabilityTerminalV1
} from '@holonomyjs/runtime/kernel/guest-facade-support'
import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import { attachChildProcessAbortV1 } from './guest-child-process-abort.js'
import type { PreparedChildProcessAbortSignalV1 } from './guest-child-process-abort.js'
import { emit, errorFrom, eventTarget } from './guest-child-process-events.js'
import {
  childProcessCallbackV1,
  childProcessInvalidStateV1,
  childProcessRecordV1,
  snapshotChildProcessStdinDataV1
} from './guest-child-process-support.js'

type Listener = (...args: unknown[]) => unknown
type Fields = Readonly<Record<string, JsonValueV1>>

const scheduleCallback = (callback: () => void) => void Promise.resolve().then(callback)

export const createChildProcessResourceFactoryV1 = (
  bridge: CapabilityGuestBridgeV1,
  scheduleNextTick?: (callback: () => void) => void
) => {
  const subscriptionDisposers = new Map<string, () => void>()
  const subscribe = (bindingId: string, listener: (event: string) => void) => {
    let actual = () => {}
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      subscriptionDisposers.delete(bindingId)
      actual()
    }
    subscriptionDisposers.set(bindingId, stop)
    try {
      actual = bridge.subscribeResource?.(bindingId, listener) ?? actual
      if (stopped) actual()
    } catch (error) {
      subscriptionDisposers.delete(bindingId)
      throw error
    }
    return stop
  }
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
    let closed = false
    const close = () => {
      closed = true
      subscriptionDisposers.get(fields.bindingId)?.()
    }
    subscribe(fields.bindingId, source => {
      const event = childProcessRecordV1(readCapabilityResourceEventV1(source))
      const tuple = Array.isArray(event.tuple) ? event.tuple : []
      if (event.event === 'end' || event.event === 'close') closed = true
      emit(listeners, String(event.event), ...(event.event === 'error' ? [errorFrom(tuple[0])] : tuple))
      if (event.event === 'close') close()
    })
    const control = (member: string) => {
      if (!closed) sync(member, {}, fields)
      return api
    }
    api.destroy = () => control('stdout/stderr.destroy')
    api.pause = () => control('stdout/stderr.pause')
    api.resume = () => control('stdout/stderr.resume')
    return { api: Object.freeze(api), close }
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
        return immediate('ChildProcess.stdin.write', snapshotChildProcessStdinDataV1(data), fields, callbackId)
      } catch (error) {
        forget(callbackId)
        throw error
      }
    }
    dispose = subscribe(fields.bindingId as string, source => {
      const event = childProcessRecordV1(readCapabilityResourceEventV1(source))
      if (event.event === 'callback') settle(event.callbackId, event.error)
      if (event.event === 'close') {
        closed = true
        ended = true
        const error = childProcessInvalidStateV1()
        for (const callbackId of [...callbacks.keys()]) settle(callbackId, error)
        dispose()
      }
    })
    return Object.freeze(api)
  }
  return (snapshot: unknown, abortSignal?: PreparedChildProcessAbortSignalV1) => {
    const source = childProcessRecordV1(snapshot)
    const fields = capabilityResourceFieldsV1(source, 'process.child')
    const nestedBindingIds = [
      source.stdin == null ? undefined : capabilityResourceFieldsV1(source.stdin, 'process.stdin').bindingId,
      source.stdout == null ? undefined : capabilityResourceFieldsV1(source.stdout, 'process.readable').bindingId,
      source.stderr == null ? undefined : capabilityResourceFieldsV1(source.stderr, 'process.readable').bindingId
    ].filter((value): value is string => value != null)
    const listeners = new Map<string, Set<Listener>>()
    const api = eventTarget(listeners, Object.create(null) as Record<string, unknown>)
    let errorDelivered = false
    const deliverError = (error: Error) => {
      if (errorDelivered) return
      errorDelivered = true
      emit(listeners, 'error', error)
    }
    const stdout = readable(source.stdout)
    const stderr = readable(source.stderr)
    Object.assign(api, {
      kill: (signal: unknown = 'SIGTERM') => sync('ChildProcess.kill', signal as JsonValueV1, fields),
      pid: source.pid,
      stderr: stderr?.api ?? null,
      stdin: stdin(source.stdin),
      stdout: stdout?.api ?? null
    })
    subscribe(fields.bindingId, eventSource => {
      const event = childProcessRecordV1(readCapabilityResourceEventV1(eventSource))
      const tuple = Array.isArray(event.tuple) ? event.tuple : []
      if (event.event === 'close') {
        stdout?.close()
        stderr?.close()
      }
      const deliver = () => {
        if (event.event === 'error') deliverError(errorFrom(tuple[0]))
        else emit(listeners, String(event.event), ...tuple)
      }
      if (event.event === 'close') scheduleCallback(deliver)
      else deliver()
      if (event.event === 'close') {
        for (const bindingId of nestedBindingIds) {
          subscriptionDisposers.get(bindingId)?.()
          try {
            bridge.releaseResource?.(bindingId)
          } catch {
            // A prior destroy or close may have released this same handle.
          }
        }
        subscriptionDisposers.get(fields.bindingId)?.()
        try {
          bridge.releaseResource?.(fields.bindingId)
        } catch {
          // Terminal cleanup remains idempotent across race and restart paths.
        }
      }
    })
    attachChildProcessAbortV1(abortSignal, api, deliverError, scheduleNextTick)
    return Object.freeze(api)
  }
}
