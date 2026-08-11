import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'vitest'

import { serveEvents } from '../router-read.mjs'

describe('process event stream', () => {
  it('applies the same process predicate to replayed and live events', async () => {
    const request = new EventEmitter()
    request.headers = {}
    const chunks = []
    let listener
    const response = {
      end() {},
      write: chunk => {
        chunks.push(chunk)
        return true
      },
      writeHead() {}
    }
    const core = {
      readEvents: async () => [
        { cursor: 1, subject: 'process-other', type: 'process.updated' },
        { cursor: 2, subject: 'process-target', type: 'process.updated' }
      ],
      subscribeEvents: callback => {
        listener = callback
        return () => undefined
      }
    }
    await serveEvents(
      request,
      response,
      core,
      new URL('http://127.0.0.1/v1/processes/process-target/events?after=0'),
      'process-target'
    )
    listener({ cursor: 3, data: { processId: 'process-other' }, type: 'process.output' })
    listener({ cursor: 4, data: { processId: 'process-target' }, type: 'process.output' })
    const output = chunks.join('')
    assert.doesNotMatch(output, /process-other/u)
    assert.match(output, /id: 2/u)
    assert.match(output, /id: 4/u)
  })
})
