import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  getCellularState,
  getConnectivity,
  getDisplay,
  getFormFactor,
  getInput,
  getLifecycle,
  getMediaCapabilities,
  getPower,
  getSecurityCapabilities,
  getSensorCapabilities,
  getSummary,
  getThermal,
  getWifiState
} from 'holo:device'
import {
  getDisplay as getDisplayPromise,
  getFormFactor as getFormFactorPromise,
  getLifecycle as getLifecyclePromise,
  getSummary as getSummaryPromise,
  getWifiIdentity,
  subscribe
} from 'holo:device/promises'

// Run explicitly with the owner-selected Native desktop Device installation and
// the matching capability profile. The Native Guest executes these assertions.
const required = reading => {
  assert.equal(typeof reading, 'object')
  assert.notEqual(reading, null)
  assert.ok(['available', 'redacted', 'unavailable', 'permissionDenied'].includes(reading.status))
  assert.ok(Number.isSafeInteger(reading.revision) && reading.revision >= 0)
  assert.ok(Number.isFinite(reading.observedAt) && reading.observedAt >= 0)
  if (reading.status === 'available') {
    assert.ok(['coarse', 'standard', 'exact'].includes(reading.precision))
    assert.ok(Object.hasOwn(reading, 'value'))
  } else if (reading.status === 'redacted') {
    assert.equal(reading.precision, 'redacted')
    assert.ok(Object.hasOwn(reading, 'value'))
  } else {
    assert.equal(reading.precision, 'none')
    assert.equal(Object.hasOwn(reading, 'value'), false)
  }
}
const normalized = reading => ({
  precision: reading.precision,
  revision: reading.revision,
  status: reading.status,
  ...(Object.hasOwn(reading, 'value') ? { value: reading.value } : {})
})
const assertSameRevision = (left, right) => {
  assert.equal(left.revision, right.revision)
  assert.deepEqual(normalized(left), normalized(right))
}

describe('Native desktop Device public contract', () => {
  it('returns the six required operations from real Guest sync and Promise entry points', async () => {
    const factor = getFormFactor()
    required(factor)
    if (factor.status === 'available') assert.ok(['desktop', 'unknown'].includes(factor.value))
    assertSameRevision(factor, await getFormFactorPromise())

    const display = getDisplay()
    const input = getInput()
    const lifecycle = getLifecycle()
    for (const reading of [display, input, lifecycle]) required(reading)
    for (
      const [sync, promised] of [
        [display, await getDisplayPromise()],
        [lifecycle, await getLifecyclePromise()]
      ]
    ) {
      required(promised)
      // A natural OS change between calls may advance this operation's revision.
      assert.ok(promised.revision >= sync.revision)
      if (promised.revision === sync.revision) assertSameRevision(sync, promised)
    }
    if (display.status === 'available') {
      assert.ok(Number.isSafeInteger(display.value.widthCssPx) && display.value.widthCssPx > 0)
      assert.ok(Number.isSafeInteger(display.value.heightCssPx) && display.value.heightCssPx > 0)
      assert.ok(Number.isFinite(display.value.scale) && display.value.scale >= 0.25)
      assert.ok(['landscape', 'portrait', 'unknown'].includes(display.value.orientation))
    }
    if (input.status === 'available') {
      assert.equal(typeof input.value.touch, 'boolean')
      assert.ok(Number.isSafeInteger(input.value.maxTouchPoints))
      assert.ok(['none', 'coarse', 'fine'].includes(input.value.pointer))
    }
    if (lifecycle.status === 'available') {
      assert.ok(['foreground', 'background', 'unknown'].includes(lifecycle.value.visibility))
      assert.ok(['normal', 'moderate', 'critical', 'unknown'].includes(lifecycle.value.memoryPressure))
    }
  })

  it('projects the exact Tier 0/1 summary fields from their independent source revisions', async () => {
    const summary = getSummary()
    const promised = await getSummaryPromise()
    for (const value of [summary, promised]) {
      assert.deepEqual(Object.keys(value).sort(), [
        'display',
        'formFactor',
        'input',
        'lifecycle',
        'power',
        'schemaVersion'
      ])
      assert.equal(value.schemaVersion, 1)
      for (const field of ['display', 'formFactor', 'input', 'lifecycle', 'power']) {
        const reading = value[field]
        if (field === 'power') {
          assert.equal(reading.status, 'unsupported')
          assert.equal(reading.precision, 'none')
          assert.equal(Object.hasOwn(reading, 'value'), false)
        } else required(reading)
      }
      assert.equal(/ssid|bssid|connectivity|thermal|sensor|security/iu.test(JSON.stringify(value)), false)
    }
    for (
      const [field, getter] of [
        ['formFactor', getFormFactor],
        ['display', getDisplay],
        ['input', getInput],
        ['lifecycle', getLifecycle]
      ]
    ) {
      const direct = getter()
      assert.ok(direct.revision >= summary[field].revision)
      if (direct.revision === summary[field].revision) assertSameRevision(summary[field], direct)
    }
    assertSameRevision(summary.formFactor, promised.formFactor)
  })

  it('delivers display/lifecycle initial snapshots and closes the generation resource', async () => {
    const subscription = await subscribe({ kinds: ['display', 'lifecycle'], maxQueuedEvents: 8 })
    try {
      assert.ok(Number.isSafeInteger(subscription.generation) && subscription.generation >= 1)
      assert.equal(subscription.maxQueuedEvents, 8)
      assert.ok(Number.isSafeInteger(subscription.startSequence))
      assert.equal(subscription[Symbol.asyncIterator](), subscription)
      const first = await subscription.next()
      const second = await subscription.next()
      assert.equal(first.done, false)
      assert.equal(second.done, false)
      assert.deepEqual([first.value.kind, second.value.kind], ['display', 'lifecycle'])
      for (const result of [first, second]) {
        assert.equal(result.value.schemaVersion, 1)
        assert.equal(result.value.phase, 'snapshot')
        assert.ok(result.value.sequence > subscription.startSequence)
        required(result.value.reading)
      }
      assert.ok(second.value.sequence > first.value.sequence)
      for (const [result, getter] of [[first, getDisplay], [second, getLifecycle]]) {
        const direct = getter()
        assert.ok(direct.revision >= result.value.reading.revision)
        if (direct.revision === result.value.reading.revision) {
          assertSameRevision(result.value.reading, direct)
        }
      }
    } finally {
      await subscription.close()
    }
    assert.deepEqual(await subscription.next(), { done: true, value: undefined })
    await subscription.close()
  })

  it('resyncs a typed overflow caused by two initial snapshots and a one-event queue', async () => {
    const subscription = await subscribe({ kinds: ['display', 'lifecycle'], maxQueuedEvents: 1 })
    try {
      assert.equal(subscription.maxQueuedEvents, 1)
      const next = await subscription.next()
      assert.equal(next.done, false)
      const overflow = next.value
      assert.equal(overflow.schemaVersion, 1)
      assert.equal(overflow.kind, 'overflow')
      assert.equal(overflow.resyncRequired, true)
      assert.ok(Number.isSafeInteger(overflow.sequence) && overflow.sequence > subscription.startSequence)
      assert.ok(Number.isSafeInteger(overflow.dropped) && overflow.dropped >= 1)
      assert.deepEqual(Object.keys(overflow.requiredRevisions).sort(), ['display', 'lifecycle'])

      const current = { display: getDisplay(), lifecycle: getLifecycle() }
      for (const kind of ['display', 'lifecycle']) {
        const requiredRevision = overflow.requiredRevisions[kind]
        assert.ok(Number.isSafeInteger(requiredRevision) && requiredRevision >= 0)
        required(current[kind])
        assert.ok(current[kind].revision >= requiredRevision)
      }
      await subscription.acknowledgeResync({
        display: current.display.revision,
        lifecycle: current.lifecycle.revision
      })
    } finally {
      await subscription.close()
    }
    assert.deepEqual(await subscription.next(), { done: true, value: undefined })
  })

  it('does not provide optional Desktop fields through an ambient fallback', async () => {
    for (
      const getter of [
        getCellularState,
        getConnectivity,
        getMediaCapabilities,
        getPower,
        getSecurityCapabilities,
        getSensorCapabilities,
        getThermal,
        getWifiState
      ]
    ) {
      assert.throws(getter, { code: 'holo.policy_denied' })
    }
    await assert.rejects(getWifiIdentity(), { code: 'holo.policy_denied' })
  })
})
