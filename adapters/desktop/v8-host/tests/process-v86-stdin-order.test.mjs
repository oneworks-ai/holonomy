import assert from 'node:assert/strict'
import { it as test } from 'vitest'

import { NativeV86ProcessHostPortV1 } from '../bootstrap/process-v86-host-port.mjs'

const waitFor = async predicate => {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Native v86 stdin command did not settle')
}

test('stdinClose waits for the preceding supervisor write acknowledgement', async () => {
  const calls = []
  const callbacks = []
  let acknowledge
  const child = {
    writeStdin() {
      calls.push('write')
      return new Promise(resolve => {
        acknowledge = resolve
      })
    },
    closeStdin() {
      calls.push('close')
      return Promise.resolve()
    },
    signal: async () => {}
  }
  const backend = {
    descriptor: { features: {} },
    spawn() {
      return {
        lease: {
          environment: Promise.resolve({ spawn: async () => child }),
          release: async () => {}
        },
        request: { stdio: ['pipe', 'ignore', 'ignore'] }
      }
    }
  }
  const names = [
    'spawn',
    'error',
    'exit',
    'close',
    'stdout',
    'stdoutEnd',
    'stdoutError',
    'stdoutClose',
    'stderr',
    'stderrEnd',
    'stderrError',
    'stderrClose',
    'stdinError',
    'stdinClose'
  ]
  const sink = Object.freeze({
    ...Object.fromEntries(names.map(name => [name, () => {}])),
    stdinCallback: (id, code) => callbacks.push([id, code])
  })
  const handle = new NativeV86ProcessHostPortV1(backend).spawn({}, {}, sink)
  handle.writeStdin(Uint8Array.of(65), 1)
  handle.endStdin(2)
  await waitFor(() => calls.includes('write'))
  assert.deepEqual(calls, ['write'])
  acknowledge()
  await waitFor(() => calls.includes('close'))
  assert.deepEqual(calls, ['write', 'close'])
  await waitFor(() => callbacks.length === 2)
  assert.deepEqual(callbacks, [[1, null], [2, null]])
})
