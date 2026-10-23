import {
  CapabilityInvocationError,
  trustedInvocationValueFromJsonV1
} from '../../../../packages/runtime/src/kernel/index.ts'
import { guestInvocationErrorV1 } from '../../../../packages/runtime/src/kernel/invocation-guest-error.ts'

export const createNativeWatchResources = native => {
  const records = new Map()
  const send = input => {
    const result = JSON.parse(native.filesystem(JSON.stringify(input)))
    if (result.ok !== true) throw new CapabilityInvocationError(result.code, 'filesystem.watch.subscribe')
    return result.value
  }
  const emit = (record, event) => {
    const code = event.tuple[0]?.code
    const value = event.event === 'error'
      ? {
        event: 'error',
        tuple: [guestInvocationErrorV1(
          new CapabilityInvocationError(
            code === 'ENOENT'
              ? 'resource.not_found'
              : code === 'ENOSPC'
              ? 'resource.event_limit'
              : 'provider.unavailable',
            'filesystem.watch.subscribe'
          ),
          'nodeFs'
        )]
      }
      : event
    const snapshot = trustedInvocationValueFromJsonV1(value, 'result')
    for (const listener of record.listeners) listener(snapshot)
  }
  const close = bindingId => {
    const record = records.get(bindingId)
    if (record == null) return
    records.delete(bindingId)
    send({ kind: 'closeWatch', bindingId })
    emit(record, { event: 'close', tuple: [] })
    record.listeners.clear()
  }
  return {
    close,
    publish(context, authority, value) {
      const { bindingId, maxQueuedEvents } = value
      const resourceType = context.module === 'node:fs/promises' ? 'filesystem.watch-iterator' : 'filesystem.watcher'
      const record = { listeners: new Set() }
      records.set(bindingId, record)
      return authority.complete(
        trustedInvocationValueFromJsonV1({
          binding: { bindingId, generation: context.runtime.generation },
          resourceType,
          maxQueuedEvents
        }, 'result'),
        [{
          bindingId,
          resource: context.resource.requested,
          resourceType,
          eventSchemaId: 'VirtualFsWatcherDeliveryV1',
          close: () => close(bindingId),
          subscribe(listener) {
            record.listeners.add(listener)
            return () => record.listeners.delete(listener)
          }
        }]
      )
    },
    poll() {
      const closed = []
      for (const { bindingId, event } of send({ kind: 'poll' })) {
        const record = records.get(bindingId)
        if (record == null) continue
        if (event.event === 'close') {
          close(bindingId)
          closed.push(bindingId)
        } else emit(record, event)
      }
      return closed
    }
  }
}
