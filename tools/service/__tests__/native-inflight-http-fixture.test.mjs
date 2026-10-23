import assert from 'node:assert/strict'
import { request } from 'node:http'
import { it } from 'vitest'

import { createNativeInflightHttpFixture, nativeInflightBounded } from './native-inflight-http-fixture.mjs'

it('confirms actual held-socket close and rejects a response release after fixture disposal', async () => {
  const fixture = await createNativeInflightHttpFixture()
  const client = request(`${fixture.origin}/held`)
  client.on('error', () => undefined)
  const clientClose = new Promise(resolve => client.once('close', resolve))
  try {
    client.end()
    await fixture.waitForHeld()
    assert.equal(fixture.heldSocketClosed(), false)
    await fixture.close()
    await fixture.waitForHeldClose()
    await nativeInflightBounded(clientClose, 'fixture client socket close')
    assert.equal(fixture.heldSocketClosed(), true)
    assert.throws(() => fixture.releaseHeld(), /held response must still be open/u)
    await fixture.close()
  } finally {
    client.destroy()
    await fixture.close()
    await nativeInflightBounded(clientClose, 'fixture final client socket close')
  }
})
