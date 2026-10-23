import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// The host supplies /real and /abort-body. The latter flushes response headers
// but withholds its body until cancellation closes the real transport socket.
// Registration is portable; the Android filename identifies the initial host.
export const registerNetworkAbortTests = ({ origin }) => {
  const outcome = promise =>
    promise.then(
      value => ({ rejected: false, value }),
      reason => ({ rejected: true, reason })
    )
  const expectReason = async (pending, reason) => {
    const result = await pending
    assert.equal(result.rejected, true)
    assert.equal(result.reason, reason)
  }
  const success = async () => {
    const response = await fetch(`${origin}/real`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'android-real-transport')
  }

  describe('response body Abort over the production transport', () => {
    it('reads a complete real response', success)
    for (const kind of ['default', 'object', 'null', 'false', 'zero']) {
      it(`preserves ${kind} reason after headers and releases its connection`, async () => {
        // Ten aborts across five cases exceed the fixture's unchanged eight
        // connection limit. Every abort is followed by a successful real fetch.
        for (let iteration = 0; iteration < 2; iteration += 1) {
          const controller = new AbortController()
          try {
            const response = await fetch(`${origin}/abort-body`, { signal: controller.signal })
            assert.equal(response.status, 200)
            assert.equal(response.headers.get('x-holonomy-body'), 'held')
            const clone = response.clone()
            const body = outcome(response.text())
            const clonedBody = outcome(clone.text())
            const suppliedReason = { object: { stop: true }, null: null, false: false, zero: 0 }[kind]
            if (kind === 'default') controller.abort()
            else controller.abort(suppliedReason)
            const reason = controller.signal.reason
            if (kind === 'default') assert.equal(reason.name, 'AbortError')
            else assert.equal(reason, suppliedReason)
            await expectReason(body, reason)
            await expectReason(clonedBody, reason)
          } finally {
            if (!controller.signal.aborted) controller.abort()
          }
          await success()
        }
      })
    }
  })
}
