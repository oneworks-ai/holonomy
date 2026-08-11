import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { createAndroidRuntimeAdapter } from '../android-target-adapter.mjs'

const process = {
  deviceId: 'android:emulator-5554',
  entryUrl: 'app+local://workspace/main.mjs',
  generation: 1,
  id: 'process_cursor',
  inspectorMode: 'off',
  isolation: 'runtime',
  launch: { argv: [], env: {}, modules: [] },
  sandboxPolicy: {
    filesystem: { access: 'none' },
    network: { access: 'none' },
    schemaVersion: 1
  }
}

describe('android log cursor', () => {
  it('advances only through the last event returned in a bounded page', async () => {
    const commandPort = {
      async command(_serial, command) {
        if (command.command !== 'status') return { ack: { generation: 1 } }
        return {
          ack: { generation: 1 },
          output: {
            events: [1, 2, 3, 4, 5].map(sequence => ({
              chunk: `event-${sequence}`,
              generation: 1,
              sequence,
              stream: 'network'
            })),
            nextSequence: 6
          }
        }
      }
    }
    const adapter = createAndroidRuntimeAdapter({ commandPort })
    await adapter.startProcess({ process })

    const first = await adapter.readLogs({ after: 0, limit: 2, process })
    assert.deepEqual(first.events.map(event => event.sequence), [1, 2])
    assert.equal(first.cursor, 2)

    const emptyCommandPort = {
      ...commandPort,
      async command(_serial, command) {
        if (command.command !== 'status') return { ack: { generation: 1 } }
        return { ack: { generation: 1 }, output: { events: [], nextSequence: 6 } }
      }
    }
    const emptyAdapter = createAndroidRuntimeAdapter({ commandPort: emptyCommandPort })
    await emptyAdapter.startProcess({ process: { ...process, id: 'process_cursor_empty' } })
    assert.equal(
      (await emptyAdapter.readLogs({
        after: 5,
        limit: 2,
        process: {
          ...process,
          id: 'process_cursor_empty'
        }
      })).cursor,
      5
    )
  })
})
