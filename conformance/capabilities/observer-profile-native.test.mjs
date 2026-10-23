import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

// Run explicitly with the Native isolated diagnostic profile fixture. The Host
// driver releases these public FS latches after observing private sink receipts;
// no Observer object, callback, private output path or PID is passed to Guest.
const flag = async name => {
  for (let attempt = 0; attempt < 1500; attempt += 1) {
    try {
      if (readFileSync(`holo-fs://workspace/${name}.txt`, 'utf8') === 'go') return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`Host fixture did not release ${name}`)
}

it('keeps ordinary Host FS and Engine Gate execution independent of diagnostic code', async () => {
  console.log('OBSERVER_PROFILE_GUEST_WAITING')
  await flag('gate')
  assert.equal(readFileSync('holo-fs://workspace/payload.txt', 'utf8'), 'public-workload-data')
  // eslint-disable-next-line no-eval -- This explicitly exercises the controlled Native Engine Gate.
  assert.equal(eval('40+2'), 42)
  console.log('OBSERVER_PROFILE_GATE_PROGRESS')
  await flag('finish')
})

it('does not expose diagnostic executor handles or Host sinks to Guest', () => {
  for (const name of ['__holoControlHost', '__holoObserverExecutor', 'observerProfiles', 'observerSink']) {
    assert.equal(typeof globalThis[name], 'undefined')
  }
  assert.deepEqual(new Uint8Array([1, 2, 3]), Uint8Array.from([1, 2, 3]))
})
