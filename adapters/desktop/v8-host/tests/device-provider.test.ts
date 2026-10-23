import { describe, expect, it } from 'vitest'

import { createGuestDeviceSubscriptionV1 } from '../../../../packages/capabilities/device/src/kernel/guest-device-subscription.ts'
import { DEVICE_OPERATIONS_V1 } from '../../../../packages/runtime/src/kernel/registry-types.ts'
import {
  NATIVE_DESKTOP_DEVICE_DESCRIPTOR_V1,
  createPrivateNativeDesktopDeviceProviderV1
} from '../bootstrap/device-provider.mjs'
import { createNativeResourceSubscriptions } from '../bootstrap/resource-subscriptions.mjs'

const grant = (maxPrivacyTier = 1, maxPrecision = 'standard') => ({ access: 'allow', maxPrecision, maxPrivacyTier })
const policy = (operations: Record<string, unknown>, maxQueuedEvents = 8) => ({
  defaultAccess: 'deny',
  maxEventsPerSecond: 100,
  maxQueuedEvents,
  maxSubscriptions: 8,
  operations
})
const reading = (value: unknown, revision = 1) => ({
  observedAt: 10,
  precision: 'standard',
  revision,
  status: 'available',
  value
})
const denied = { observedAt: 10, precision: 'none', revision: 0, status: 'permissionDenied' }
const display = (widthCssPx = 1440) => ({
  hdr: 'unknown',
  heightCssPx: 900,
  orientation: 'landscape',
  scale: 2,
  wideColor: 'unknown',
  widthCssPx
})
const lifecycle = {
  interactive: true,
  memoryPressure: 'unknown',
  visibility: 'unknown'
}

const fixture = (
  operations: Record<string, unknown>,
  opts: {
    cancelSchedule?: (id: number) => void
    maxQueuedEvents?: number
    schedule?: (callback: () => void, delay: number) => number
  } = {}
) => {
  let clock = 0
  let displayRevision = 1
  let displayWidth = 1440
  const calls: Array<Record<string, unknown>> = []
  const device = createPrivateNativeDesktopDeviceProviderV1({
    cancelSchedule: opts.cancelSchedule,
    generation: 1,
    nativeDevice: (json: string) => {
      const command = JSON.parse(json)
      calls.push(command)
      if (command.kind === 'install') return JSON.stringify({ ok: true, schemaVersion: 1, value: { generation: 1 } })
      if (command.kind === 'close') return JSON.stringify({ ok: true, schemaVersion: 1, value: {} })
      let value
      switch (command.operation) {
        case 'device.display.read':
          value = {
            ...reading(
              command.maxPrecision === 'coarse'
                ? { ...display(Math.max(1, Math.round(displayWidth / 100) * 100)), scale: 2 }
                : command.maxPrecision === 'exact'
                ? { ...display(displayWidth), refreshRateHz: 60 }
                : display(displayWidth),
              displayRevision
            ),
            precision: command.maxPrecision
          }
          break
        case 'device.lifecycle.read':
          value = reading(lifecycle)
          break
        case 'device.summary.read':
          value = {
            display: operations['device.display.read'] == null ? denied : reading(display()),
            formFactor: denied,
            input: denied,
            lifecycle: denied,
            power: denied,
            schemaVersion: 1
          }
          break
        default:
          value = denied
      }
      return JSON.stringify({ ok: true, schemaVersion: 1, value })
    },
    now: () => clock,
    policy: policy(operations, opts.maxQueuedEvents),
    schedule: opts.schedule
  })
  const authority = (allowed: string[], maxPrivacyTier = 1, maxPrecision = 'standard') => ({
    bindings: [{
      constraints: {
        maxPrecision,
        maxPrivacyTier,
        maxQueuedEvents: opts.maxQueuedEvents ?? 8,
        operations: allowed
      },
      providerModule: 'host.device'
    }],
    complete(result: unknown, resources?: unknown[]) {
      return { resources, result }
    }
  })
  const context = (operation: string, args: Record<string, unknown> = {}) => ({
    arguments: args,
    operation,
    resource: {
      requested: {
        kind: 'deviceField',
        operation,
        privacyTier: operation === 'device.events.subscribe' ? 0 : 1
      }
    },
    runtime: { generation: 1 }
  })
  return {
    authority,
    calls,
    context,
    device,
    setClock: (value: number) => clock = value,
    setDisplay: (width: number, revision: number) => {
      displayWidth = width
      displayRevision = revision
    }
  }
}

describe('private Native Desktop Device Provider', () => {
  it('publishes exactly the Desktop required operations and two event kinds', () => {
    const descriptor = NATIVE_DESKTOP_DEVICE_DESCRIPTOR_V1
    expect(descriptor.operations.map(item => item.operation)).toEqual(DEVICE_OPERATIONS_V1)
    expect(descriptor.operations.filter(item => item.supportLevel === 'required').map(item => item.operation)).toEqual([
      'device.display.read',
      'device.events.subscribe',
      'device.form-factor.read',
      'device.input.read',
      'device.lifecycle.read',
      'device.summary.read'
    ])
    expect(descriptor.operations.find(item => item.operation === 'device.events.subscribe')?.eventKinds).toEqual([
      'display',
      'lifecycle'
    ])
    expect(descriptor.operations.filter(item => item.supportLevel === 'unsupported')).toHaveLength(9)
  })

  it('validates injected authority before any OS read and closes once', () => {
    const f = fixture({ 'device.display.read': grant() })
    expect(() =>
      f.device.provider.invoke(
        f.context('device.display.read') as never,
        f.authority([]) as never
      )
    ).toThrow()
    expect(f.calls.map(call => call.kind)).toEqual(['install'])
    const terminal = f.device.provider.invoke(
      f.context('device.display.read') as never,
      f.authority(['device.display.read']) as never
    ) as { result: { value: { revision: number } } }
    expect(terminal.result.value.revision).toBe(1)
    expect(f.calls.filter(call => call.kind === 'read')).toHaveLength(1)
    f.device.close()
    f.device.close()
    expect(f.calls.filter(call => call.kind === 'close')).toHaveLength(1)
  })

  it('passes the selected coarse or exact ceiling to one Rust source', () => {
    const f = fixture({ 'device.display.read': grant(1, 'exact') })
    const coarse = f.device.provider.invoke(
      f.context('device.display.read') as never,
      f.authority(['device.display.read'], 1, 'coarse') as never
    ) as { result: { value: { precision: string; revision: number; value: { widthCssPx: number } } } }
    expect(coarse.result.value).toMatchObject({
      precision: 'coarse',
      revision: 1,
      value: { widthCssPx: 1400 }
    })
    const exact = f.device.provider.invoke(
      f.context('device.display.read') as never,
      f.authority(['device.display.read'], 1, 'exact') as never
    ) as { result: { value: { precision: string; revision: number; value: { refreshRateHz: number } } } }
    expect(exact.result.value).toMatchObject({
      precision: 'exact',
      revision: 1,
      value: { refreshRateHz: 60 }
    })
    expect(f.calls.filter(call => call.kind === 'read').map(call => call.maxPrecision)).toEqual(['coarse', 'exact'])
  })

  it('keeps independently granted summary fields with higher ceilings under Tier 1 selection', () => {
    const f = fixture({ 'device.display.read': grant(3), 'device.summary.read': grant() })
    const result = f.device.provider.invoke(
      f.context('device.summary.read') as never,
      f.authority(['device.summary.read']) as never
    ) as { result: { value: { display: { status: string }; input: { revision: number } } } }
    expect(result.result.value.display.status).toBe('available')
    expect(result.result.value.input.revision).toBe(0)
    expect(f.calls.filter(call => call.kind === 'read')).toHaveLength(1)
  })

  it('rejects a selected zero event queue before baseline OS reads', () => {
    const ops = {
      'device.display.read': grant(),
      'device.events.subscribe': grant()
    }
    const f = fixture(ops)
    const authority = f.authority(Object.keys(ops))
    authority.bindings[0]!.constraints.maxQueuedEvents = 0
    expect(() =>
      f.device.provider.invoke(
        f.context('device.events.subscribe', { kinds: ['display'] }) as never,
        authority as never
      )
    ).toThrow()
    expect(f.calls.map(call => call.kind)).toEqual(['install'])
  })

  it('preserves source sequence after Host relay overflow and accepts the next change', async () => {
    const ops = {
      'device.display.read': grant(),
      'device.events.subscribe': grant(),
      'device.lifecycle.read': grant()
    }
    const f = fixture(ops, { maxQueuedEvents: 1 })
    const auth = f.authority(Object.keys(ops))
    const publication = f.device.provider.invoke(
      f.context('device.events.subscribe', { kinds: ['display', 'lifecycle'], maxQueuedEvents: 1 }) as never,
      auth as never
    ) as { resources: Array<{ bindingId: string; subscribe(listener: (value: unknown) => void): () => void }> }
    const resource = publication.resources[0]!
    const kernel = {
      resourceEventDescriptor: () => ({ eventSchemaId: 'HoloDeviceEventV1', providerModule: 'host.device' }),
      releaseResource() {},
      subscribeResource(_id: string, listener: (value: unknown) => void) {
        return resource.subscribe((value: { value: unknown }) => listener(value.value))
      }
    }
    const relay = createNativeResourceSubscriptions(
      kernel,
      new Map([['host.device', f.device.provider]]),
      1
    )
    const id = relay.subscribe(resource.bindingId)
    f.setDisplay(1500, 2)
    f.setClock(300)
    const initial = JSON.parse(relay.drain()).events.map((item: { event: string }) => JSON.parse(item.event))
    expect(initial[0].kind).toBe('overflow')
    expect(initial[0].requiredRevisions).toEqual({ display: 2, lifecycle: 1 })
    expect(initial.map((event: { sequence: number }) => event.sequence)).toEqual(
      [...initial.map((event: { sequence: number }) => event.sequence)].sort((a, b) => a - b)
    )
    const guest = createGuestDeviceSubscriptionV1({
      generation: 1,
      kinds: ['display', 'lifecycle'],
      maxQueuedEvents: 8,
      onClose() {},
      startSequence: 0
    })
    for (const event of initial) guest.accept(event)
    expect((await guest.resource.next()).value.kind).toBe('overflow')
    await guest.resource.acknowledgeResync({ display: 2, lifecycle: 1 })
    f.setDisplay(1600, 3)
    f.setClock(600)
    const changed = JSON.parse(relay.drain()).events.map((item: { event: string }) => JSON.parse(item.event))
    expect(changed[0].sequence).toBeGreaterThan(initial.at(-1).sequence)
    for (const event of changed) guest.accept(event)
    const next = await guest.resource.next()
    expect(next.value.kind).toBe('display')
    expect(next.value.reading.revision).toBe(3)
    relay.unsubscribe(id)
    await guest.resource.close()
    f.device.close()
  })

  it('references only active Device subscriptions with the existing Host timer', () => {
    let nextTimer = 0
    const scheduled = new Map<number, () => void>()
    const cancelled: number[] = []
    const f = fixture({
      'device.display.read': grant(),
      'device.events.subscribe': grant()
    }, {
      cancelSchedule: id => {
        cancelled.push(id)
        scheduled.delete(id)
      },
      schedule: (callback, delay) => {
        expect(delay).toBe(250)
        scheduled.set(++nextTimer, callback)
        return nextTimer
      }
    })
    expect(scheduled.size).toBe(0)
    const published = f.device.provider.invoke(
      f.context('device.events.subscribe', { kinds: ['display'] }) as never,
      f.authority(['device.events.subscribe', 'device.display.read']) as never
    ) as { resources: Array<{ close(): void }> }
    expect(scheduled.size).toBe(1)
    f.setClock(250)
    const callback = scheduled.get(nextTimer)!
    scheduled.delete(nextTimer)
    callback()
    expect(scheduled.size).toBe(1)
    published.resources[0]!.close()
    expect(cancelled).toEqual([2])
    expect(scheduled.size).toBe(0)
    f.device.close()
  })
})
