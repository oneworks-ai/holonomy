import { CapabilityInvocationError } from '../../../../packages/runtime/src/kernel/errors.ts'
import { guestInvocationErrorV1 } from '../../../../packages/runtime/src/kernel/invocation-guest-error.ts'
import { utf8ByteLength } from '../../../../packages/runtime/src/kernel/validation.ts'
import { drainNativeEventBatch } from './event-batch.mjs'

const EVENT_QUEUE_LIMIT = 4096
const SUBSCRIPTION_LIMIT = 256
// Keep two terminal slots per subscription available when ordinary events fill
// the queue. Dropped data must never prevent an error/close terminal.
const ORDINARY_QUEUE_LIMIT = EVENT_QUEUE_LIMIT - 5 * SUBSCRIPTION_LIMIT
const ORDINARY_EVENT_BYTES_LIMIT = 32 * 1024 * 1024
// Count the outer transport record: inner JSON escaping can double again.
const eventBytes = item => utf8ByteLength(JSON.stringify(item)) + 1

const delivery = (descriptor, filesystemMaximum, providers, bindingId) => {
  switch (descriptor.eventSchemaId) {
    case 'VirtualFsWatcherDeliveryV1':
      if (descriptor.providerModule !== 'host.fs') break
      return { family: 'nodeFs', operation: 'filesystem.watch.subscribe', maximum: filesystemMaximum }
    case 'ChildProcessEventV1':
      if (descriptor.providerModule !== 'host.process') break
      return { family: 'childProcess', operation: 'process.wait', maximum: 256 }
    case 'ChildProcessReadableEventV1':
      if (descriptor.providerModule !== 'host.process') break
      return { family: 'childProcess', operation: 'process.wait', maximum: 256 }
    case 'ChildProcessStdinEventV1':
      if (descriptor.providerModule !== 'host.process') break
      return { family: 'childProcess', operation: 'process.stdin.write', maximum: 256 }
    case 'HoloDeviceEventV1':
      if (descriptor.providerModule !== 'host.device') break
      return {
        family: 'device',
        maximum: providers.get('host.device')?.maxQueuedEventsFor?.(bindingId),
        operation: 'device.events.subscribe'
      }
  }
  throw new Error('Unsupported native resource event schema')
}

const overflowEvents = (schemaId, error) => {
  if (schemaId === 'ChildProcessStdinEventV1') return [{ event: 'close' }]
  return [
    { event: 'error', tuple: [error] },
    {
      event: 'close',
      tuple: schemaId === 'ChildProcessEventV1' ? [null, 'SIGKILL'] : []
    }
  ]
}

export const createNativeResourceSubscriptions = (kernel, providers, maximum) => {
  const records = new Map()
  const closePending = new Set()
  let next = 0
  let queue = []
  let queuedBytes = 0
  const recount = () => {
    queuedBytes = queue.reduce((total, item) => total + eventBytes(item), 0)
  }
  const closeResource = bindingId => {
    try {
      kernel.releaseResource(bindingId)
    } catch {}
  }
  return {
    subscribe(bindingId) {
      if (
        records.size >= SUBSCRIPTION_LIMIT ||
        queue.length >= ORDINARY_QUEUE_LIMIT ||
        next >= Number.MAX_SAFE_INTEGER
      ) {
        throw new Error('Native resource subscription limit')
      }
      const descriptor = kernel.resourceEventDescriptor(bindingId)
      const configuration = delivery(descriptor, maximum, providers, bindingId)
      if (!Number.isSafeInteger(configuration.maximum) || configuration.maximum < 1) {
        throw new Error('Native resource event limit is invalid')
      }
      const subscriptionId = `subscription-${++next}`
      const record = { bindingId, terminal: false, dispose: () => {} }
      records.set(subscriptionId, record)
      try {
        record.dispose = kernel.subscribeResource(bindingId, event => {
          if (record.terminal || !records.has(subscriptionId)) return
          const item = { subscriptionId, event: JSON.stringify(event) }
          if (
            queue.length >= ORDINARY_QUEUE_LIMIT ||
            queuedBytes + eventBytes(item) > ORDINARY_EVENT_BYTES_LIMIT ||
            queue.filter(item => item.subscriptionId === subscriptionId).length >= configuration.maximum
          ) {
            if (configuration.family === 'device') {
              const previous = queue.filter(item => item.subscriptionId === subscriptionId)
              queue = queue.filter(item => item.subscriptionId !== subscriptionId)
              recount()
              const replacements = providers.get('host.device').overflow(
                bindingId,
                [...previous.map(item => JSON.parse(item.event)), event]
              )
              for (const replacement of replacements) {
                const next = { subscriptionId, event: JSON.stringify(replacement) }
                queue.push(next)
                queuedBytes += eventBytes(next)
              }
              return
            }
            record.terminal = true
            queue = queue.filter(item => item.subscriptionId !== subscriptionId)
            recount()
            const failure = guestInvocationErrorV1(
              new CapabilityInvocationError('resource.event_limit', configuration.operation),
              configuration.family
            )
            for (const event of overflowEvents(descriptor.eventSchemaId, failure)) {
              const terminal = { subscriptionId, event: JSON.stringify(event) }
              queue.push(terminal)
              queuedBytes += eventBytes(terminal)
            }
            closePending.add(bindingId)
            records.delete(subscriptionId)
            record.dispose()
          } else {
            queue.push(item)
            queuedBytes += eventBytes(item)
            if (event.event === 'close') {
              record.terminal = true
              records.delete(subscriptionId)
              record.dispose()
            }
          }
        })
        if (!records.has(subscriptionId)) record.dispose()
      } catch (error) {
        records.delete(subscriptionId)
        throw error
      }
      return subscriptionId
    },
    unsubscribe(subscriptionId) {
      const record = records.get(subscriptionId)
      if (record != null) {
        records.delete(subscriptionId)
        record.dispose()
      }
      queue = queue.filter(item => item.subscriptionId !== subscriptionId)
      recount()
    },
    drain() {
      for (const provider of providers.values()) {
        for (const bindingId of provider.poll?.() ?? []) closePending.add(bindingId)
      }
      for (const bindingId of closePending) closeResource(bindingId)
      closePending.clear()
      const batch = drainNativeEventBatch(queue)
      recount()
      return batch
    },
    close() {
      for (const record of records.values()) record.dispose()
      records.clear()
      queue = []
      queuedBytes = 0
      closePending.clear()
    }
  }
}
