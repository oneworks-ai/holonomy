import { describe, expect, it } from 'vitest'

import {
  CapabilityContractError,
  DEVICE_OPERATIONS_V1,
  compileDeviceProviderDescriptorV1,
  createGuestDeviceSubscriptionV1,
  normalizeDeviceEventV1,
  normalizeDeviceReadingV1,
  normalizeDeviceSubscriptionOptionsV1,
  normalizeDeviceSummaryV1
} from '../../../src/capability-runtime/index.js'
import type { DeviceOperationV1 } from '../../../src/capability-runtime/index.js'

const observed = { observedAt: 100, precision: 'standard', revision: 1, status: 'available' }
const reading = (value: unknown) => ({ ...observed, value })

const requiredAndroid = new Set<DeviceOperationV1>([
  'device.connectivity.cellular.state.read',
  'device.connectivity.read',
  'device.connectivity.wifi.state.read',
  'device.display.read',
  'device.events.subscribe',
  'device.form-factor.read',
  'device.input.read',
  'device.lifecycle.read',
  'device.power.read',
  'device.summary.read'
])

const androidDescriptor = () => ({
  operations: DEVICE_OPERATIONS_V1.map(operation => ({
    eventKinds: operation === 'device.events.subscribe'
      ? ['connectivity', 'display', 'lifecycle', 'power']
      : [],
    maxPrecision: requiredAndroid.has(operation) ? 'standard' : 'exact',
    operation,
    permissionModel: operation.includes('wifi.identity') ? 'hostAndPlatform' : 'host',
    supportLevel: requiredAndroid.has(operation) ? 'required' : 'optional'
  })),
  providerVersion: '1.0.0',
  schemaVersion: 1,
  target: 'android'
})

describe('holo:device v1 machine contract', () => {
  it('normalizes available/redacted/unavailable readings without mixing discriminants', () => {
    expect(normalizeDeviceReadingV1(
      'device.connectivity.wifi.state.read',
      reading({
        connected: true,
        signalPercent: 75
      })
    )).toEqual(reading({ connected: true, signalPercent: 75 }))
    expect(normalizeDeviceReadingV1('device.form-factor.read', {
      observedAt: 1,
      precision: 'redacted',
      revision: 2,
      status: 'redacted',
      value: 'unknown'
    })).toEqual({
      observedAt: 1,
      precision: 'redacted',
      revision: 2,
      status: 'redacted',
      value: 'unknown'
    })
    expect(normalizeDeviceReadingV1('device.power.read', {
      observedAt: 1,
      precision: 'none',
      revision: 2,
      status: 'unavailable'
    })).toEqual({ observedAt: 1, precision: 'none', revision: 2, status: 'unavailable' })
  })

  it('keeps summary strictly Tier 0/1', () => {
    const summary = normalizeDeviceSummaryV1({
      display: reading({
        hdr: 'unknown',
        heightCssPx: 800,
        orientation: 'portrait',
        scale: 2,
        wideColor: 'unknown',
        widthCssPx: 400
      }),
      formFactor: reading('phone'),
      input: reading({
        hover: false,
        keyboard: false,
        maxTouchPoints: 5,
        mouse: false,
        pointer: 'coarse',
        touch: true
      }),
      lifecycle: reading({ interactive: true, memoryPressure: 'normal', visibility: 'foreground' }),
      power: reading({ charging: true, hasBattery: true, levelPercent: 80, lowPowerMode: false, source: 'usb' }),
      schemaVersion: 1
    })
    expect(Object.keys(summary)).toEqual(['display', 'formFactor', 'input', 'lifecycle', 'power', 'schemaVersion'])
    expect(JSON.stringify(summary)).not.toMatch(/connectivity|ssid|bssid|thermal/iu)
  })

  it('requires exact target operation/event support descriptors', () => {
    const compiled = compileDeviceProviderDescriptorV1(androidDescriptor())
    expect(compiled.operations).toHaveLength(DEVICE_OPERATIONS_V1.length)
    expect(compiled.operations.filter(item => item.supportLevel === 'required').map(item => item.operation))
      .toEqual([...requiredAndroid].sort())

    const missing = androidDescriptor()
    missing.operations = missing.operations.slice(1)
    expect(() => compileDeviceProviderDescriptorV1(missing)).toThrow(CapabilityContractError)

    const weak = androidDescriptor()
    weak.operations.find(item => item.operation === 'device.power.read')!.supportLevel = 'optional'
    expect(() => compileDeviceProviderDescriptorV1(weak)).toThrow(CapabilityContractError)
  })

  it('locks snapshot/change and overflow resync envelopes', () => {
    expect(normalizeDeviceEventV1({
      kind: 'connectivity',
      observedAt: 10,
      phase: 'snapshot',
      reading: reading({
        captivePortal: 'unknown',
        metered: false,
        online: true,
        quality: 'good',
        roaming: false,
        transports: ['wifi'],
        validated: true
      }),
      schemaVersion: 1,
      sequence: 1
    })).toEqual(expect.objectContaining({ kind: 'connectivity', phase: 'snapshot', sequence: 1 }))
    expect(normalizeDeviceEventV1({
      dropped: 3,
      kind: 'overflow',
      observedAt: 11,
      requiredRevisions: { connectivity: 4, thermal: 2 },
      resyncRequired: true,
      schemaVersion: 1,
      sequence: 5
    })).toEqual(expect.objectContaining({ dropped: 3, kind: 'overflow', resyncRequired: true }))
    expect(normalizeDeviceSubscriptionOptionsV1({ kinds: ['thermal', 'connectivity'], maxQueuedEvents: 8 }))
      .toEqual({ kinds: ['connectivity', 'thermal'], maxQueuedEvents: 8 })
  })

  it('bounds subscription queues and requires getter revisions before resync', async () => {
    let closes = 0
    const subscription = createGuestDeviceSubscriptionV1({
      generation: 7,
      kinds: ['connectivity', 'thermal'],
      maxQueuedEvents: 2,
      onClose: () => {
        closes++
      },
      startSequence: 0
    })
    const event = (kind: 'connectivity' | 'thermal', revision: number, sequence: number, phase = 'change') => ({
      kind,
      observedAt: 100 + sequence,
      phase,
      reading: kind === 'connectivity'
        ? {
          ...reading({
            captivePortal: 'unknown',
            metered: false,
            online: true,
            quality: 'good',
            roaming: false,
            transports: ['wifi'],
            validated: true
          }),
          revision
        }
        : { ...reading({ state: 'nominal' }), revision },
      schemaVersion: 1,
      sequence
    })
    subscription.accept(event('connectivity', 1, 1, 'snapshot'))
    subscription.accept(event('thermal', 1, 2, 'snapshot'))
    subscription.accept(event('connectivity', 2, 3))
    const overflow = await subscription.resource.next()
    expect(overflow.value).toMatchObject({
      dropped: 3,
      kind: 'overflow',
      requiredRevisions: { connectivity: 2, thermal: 1 },
      sequence: 3
    })
    subscription.accept(event('connectivity', 3, 4))
    subscription.accept(event('thermal', 2, 5))
    await expect(subscription.resource.acknowledgeResync({ connectivity: 4, thermal: 1 }))
      .rejects.toMatchObject({ code: 'holo.invalid_arguments' })
    await expect(subscription.resource.acknowledgeResync({ connectivity: 2 }))
      .rejects.toMatchObject({ code: 'holo.invalid_arguments' })
    await subscription.resource.acknowledgeResync({ connectivity: 2, thermal: 1 })
    await expect(subscription.resource.next()).resolves.toMatchObject({
      done: false,
      value: { kind: 'connectivity', reading: { revision: 3 }, sequence: 4 }
    })
    await expect(subscription.resource.next()).resolves.toMatchObject({
      done: false,
      value: { kind: 'thermal', reading: { revision: 2 }, sequence: 5 }
    })
    const pending = subscription.resource.next()
    await subscription.resource.close()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await subscription.resource.close()
    subscription.accept(event('connectivity', 4, 6))
    expect(closes).toBe(1)
  })

  it.each(
    [
      ['device.connectivity.wifi.state.read', reading({ connected: false, signalPercent: 10 })],
      ['device.connectivity.cellular.state.read', reading({ connected: false, radio: '5g' })],
      ['device.connectivity.wifi.identity.read', reading({})],
      [
        'device.power.read',
        reading({ charging: true, hasBattery: false, levelPercent: 20, lowPowerMode: false, source: 'battery' })
      ],
      [
        'device.input.read',
        reading({ hover: false, keyboard: false, maxTouchPoints: 1, mouse: false, pointer: 'none', touch: false })
      ],
      ['device.form-factor.read', {
        observedAt: 1,
        precision: 'none',
        revision: 1,
        status: 'unsupported',
        value: 'phone'
      }]
    ] as const
  )('rejects invalid cross-field reading for %s', (operation, value) => {
    expect(() => normalizeDeviceReadingV1(operation, value)).toThrow(CapabilityContractError)
  })
})
