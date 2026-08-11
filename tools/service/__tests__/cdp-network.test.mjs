import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { CdpNetworkProjector } from '../cdp-network.mjs'

const request = (overrides = {}) => ({
  hasPostData: false,
  headers: [['accept', 'application/json'], ['x-repeat', 'a'], ['X-Repeat', 'b']],
  method: 'GET',
  requestId: 'request_public',
  timestampMs: 1_000,
  type: 'requestWillBeSent',
  url: 'http://127.0.0.1:8080/profile',
  ...overrides
})

describe('cdp network projection', () => {
  it('emits complete base and ExtraInfo events from sanitized Fetch diagnostics', () => {
    const projector = new CdpNetworkProjector({ now: () => 1_700_000_000_000 })
    const started = projector.project('process:1', request(), { loaderId: 'loader-1' })
    assert.deepEqual(started.map(message => message.method), [
      'Network.requestWillBeSent',
      'Network.requestWillBeSentExtraInfo'
    ])
    assert.equal(started[0].params.loaderId, 'loader-1')
    assert.equal(started[0].params.wallTime, 1_700_000_000)
    assert.equal(started[0].params.request.referrerPolicy, 'no-referrer')
    assert.equal(started[0].params.request.hasPostData, false)
    assert.equal(started[1].params.headers['x-repeat'], 'a\nb')
    assert.deepEqual(started[1].params.associatedCookies, [])

    const received = projector.project('process:1', {
      headers: [['content-type', 'application/json; charset=UTF-8']],
      requestId: 'request_public',
      source: 'real',
      status: 200,
      statusText: 'OK',
      timestampMs: 1_012,
      type: 'responseReceived',
      url: 'http://127.0.0.1:8080/profile'
    }, { loaderId: 'loader-1' })
    assert.deepEqual(received.map(message => message.method), [
      'Network.responseReceived',
      'Network.responseReceivedExtraInfo'
    ])
    const response = received[0].params.response
    assert.equal(received[0].params.hasExtraInfo, true)
    assert.equal(response.mimeType, 'application/json')
    assert.equal(response.charset, 'utf-8')
    assert.equal(response.protocol, 'http/1.1')
    assert.equal(response.remoteIPAddress, '127.0.0.1')
    assert.equal(response.remotePort, 8080)
    assert.equal(response.timing.receiveHeadersEnd, 12)
    assert.equal(response.securityState, 'neutral')
    assert.equal(received[1].params.resourceIPAddressSpace, 'Loopback')
  })

  it('identifies Mock responses without inventing a remote endpoint and releases terminal state', () => {
    const projector = new CdpNetworkProjector({ now: () => 20 })
    projector.project('process:2', request({ requestId: 'mock-request', url: 'https://mock.invalid/value' }))
    const [received] = projector.project('process:2', {
      headers: [],
      requestId: 'mock-request',
      source: 'mock',
      status: 204,
      statusText: 'No Content',
      timestampMs: 1_001,
      type: 'responseReceived',
      url: 'https://mock.invalid/value'
    })
    assert.equal(received.params.response.protocol, 'holonomy-mock')
    assert.equal(received.params.response.holonomySource, 'mock')
    assert.equal(received.params.response.securityState, 'neutral')
    assert.equal('remoteIPAddress' in received.params.response, false)
    projector.project('process:2', {
      requestId: 'mock-request',
      timestampMs: 1_002,
      totalBytes: 0,
      type: 'loadingFinished'
    })
    assert.deepEqual(projector.snapshot(), { requests: 0 })
  })

  it('maps stable Fetch failures to recognizable DevTools network errors', () => {
    const projector = new CdpNetworkProjector()
    const [failed] = projector.project('process:3', {
      cancelled: false,
      code: 'network.connection_refused',
      requestId: 'failed-request',
      timestampMs: 2,
      type: 'loadingFailed'
    })
    assert.equal(failed.params.errorText, 'net::ERR_CONNECTION_REFUSED')
  })
})
