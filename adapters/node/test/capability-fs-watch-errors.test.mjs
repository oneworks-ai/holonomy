import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import nodeFs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Real Node adapter primitive boundary.
import test from 'node:test'

import {
  canonicalizeFilesystemResource,
  operationSchemaOwnerV1,
  validateFiniteJsonSchemaV1
} from '@holonomyjs/runtime/kernel'

import { NodeFilesystemResourcesV1 } from '../src/capability-fs-resources.mjs'

test('watch Provider errors pass the shared event schema and never expose native messages', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'holo-watch-error-'))
  const original = nodeFs.watch
  const watcher = new EventEmitter()
  let closed = 0
  watcher.close = () => {
    closed += 1
  }
  try {
    nodeFs.watch = () => watcher
    const resources = new NodeFilesystemResourcesV1()
    const context = {
      module: 'node:fs',
      arguments: { options: {} },
      runtime: { generation: 1 },
      authorityBindings: [{ constraints: { limits: { maxWatchers: 1, maxQueuedEvents: 1 } } }]
    }
    const terminal = resources.watch(
      context,
      { complete: (result, publications) => ({ result, publications }) },
      canonicalizeFilesystemResource('holo-fs://workspace/', 'watch'),
      directory
    )
    const events = []
    terminal.publications[0].subscribe(snapshot => events.push(snapshot.value))
    watcher.emit('error', Object.assign(new Error(`native-only ${directory}`), { code: 'ENOENT' }))
    assert.deepEqual(events.map(event => event.event), ['error', 'close'])
    assert.ok(
      events.every(event =>
        validateFiniteJsonSchemaV1(operationSchemaOwnerV1('VirtualFsWatcherDeliveryV1').schema, event)
      )
    )
    assert.equal(events[0].tuple[0].code, 'ENOENT')
    assert.equal(JSON.stringify(events).includes(directory), false)
    terminal.publications[0].close()
    assert.equal(closed, 1)
  } finally {
    nodeFs.watch = original
    await rm(directory, { recursive: true, force: true })
  }
})
