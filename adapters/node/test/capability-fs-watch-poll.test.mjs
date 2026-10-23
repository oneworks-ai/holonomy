import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import nodeFs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Real Node adapter primitive boundary.
import test from 'node:test'

import { createFsWatchPollV1, createFsWatchSourceV1 } from '../src/capability-fs-watch-poll.mjs'

test('filesystem watch polling detects file writes without native watch callbacks and stops on close', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'holo-watch-poll-'))
  const target = path.join(directory, 'sample.txt')
  nodeFs.writeFileSync(target, 'one')
  const events = []
  const errors = []
  let poller
  try {
    poller = createFsWatchPollV1(target, {
      directory: false,
      persistent: false,
      onChange: (event, filename) => events.push([event, filename]),
      onError: error => errors.push(error)
    })
    nodeFs.writeFileSync(target, 'longer second version')
    assert.equal(poller.poll(), 1)
    nodeFs.writeFileSync(path.join(directory, '.holonomy-transient'), 'internal')
    assert.equal(poller.poll(), 0)
    assert.deepEqual(events, [['change', 'sample.txt']])
    assert.deepEqual(errors, [])
    poller.close()
    nodeFs.writeFileSync(path.join(directory, 'another.txt'), 'later')
    assert.equal(poller.poll(), -1)
    assert.equal(events.length, 1)
  } finally {
    poller?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('directory polling emits a filename-free change when no native callback arrives', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'holo-watch-poll-'))
  const events = []
  const poller = createFsWatchPollV1(directory, {
    directory: true,
    persistent: false,
    onChange: (event, filename) => events.push([event, filename]),
    onError: error => assert.fail(error)
  })
  try {
    nodeFs.writeFileSync(path.join(directory, 'sample.txt'), 'sample')
    assert.equal(poller.poll(), 1)
    assert.deepEqual(events, [['change', null]])
  } finally {
    poller.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('directory-only fallback cannot infer an in-place child write without a native callback', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'holo-watch-poll-'))
  const target = path.join(directory, 'sample.txt')
  nodeFs.writeFileSync(target, 'one')
  const events = []
  const poller = createFsWatchPollV1(directory, {
    directory: true,
    persistent: false,
    onChange: (event, filename) => events.push([event, filename]),
    onError: error => assert.fail(error)
  })
  try {
    nodeFs.writeFileSync(target, 'longer second version')
    assert.equal(poller.poll(), 0)
    assert.deepEqual(events, [])
  } finally {
    poller.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('filesystem watch polling reports a vanished target once', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'holo-watch-poll-'))
  const target = path.join(directory, 'sample.txt')
  nodeFs.writeFileSync(target, 'present')
  const errors = []
  const poller = createFsWatchPollV1(target, {
    directory: false,
    persistent: false,
    onChange: () => assert.fail('vanished target must not emit a change'),
    onError: error => errors.push(error.code)
  })
  try {
    nodeFs.unlinkSync(target)
    assert.equal(poller.poll(), -1)
    assert.equal(poller.poll(), -1)
    assert.deepEqual(errors, ['ENOENT'])
  } finally {
    poller.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('repeated native callbacks wake one snapshot change only', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'holo-watch-poll-'))
  const original = nodeFs.watch
  const watcher = new EventEmitter()
  watcher.close = () => {}
  let callback
  let source
  const changes = []
  try {
    nodeFs.watch = (_target, _options, listener) => {
      callback = listener
      return watcher
    }
    source = createFsWatchSourceV1(directory, {
      directory: true,
      persistent: false,
      onChange: (event, name) => changes.push([event, name]),
      onError: error => assert.fail(error)
    })
    nodeFs.writeFileSync(path.join(directory, 'sample.txt'), 'sample')
    callback('rename', 'sample.txt')
    callback('rename', 'sample.txt')
    assert.deepEqual(changes, [['change', null]])
  } finally {
    source?.close()
    nodeFs.watch = original
    await rm(directory, { recursive: true, force: true })
  }
})

test('a change during native watch registration remains visible to the polling baseline', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'holo-watch-poll-'))
  const original = nodeFs.watch
  const watcher = new EventEmitter()
  watcher.close = () => {}
  const changes = []
  let source
  try {
    nodeFs.watch = () => {
      nodeFs.writeFileSync(path.join(directory, 'early.txt'), 'early')
      return watcher
    }
    source = createFsWatchSourceV1(directory, {
      directory: true,
      persistent: false,
      onChange: (event, filename) => changes.push([event, filename]),
      onError: error => assert.fail(error)
    })
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.deepEqual(changes, [['change', null]])
  } finally {
    source?.close()
    nodeFs.watch = original
    await rm(directory, { recursive: true, force: true })
  }
})

test('replacing a watched directory with an outside symlink never reveals outside names', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'holo-watch-poll-'))
  const inside = path.join(base, 'inside')
  const moved = path.join(base, 'moved')
  const outside = path.join(base, 'outside')
  nodeFs.mkdirSync(inside)
  nodeFs.mkdirSync(outside)
  nodeFs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  const changes = []
  const errors = []
  const poller = createFsWatchPollV1(inside, {
    directory: true,
    persistent: false,
    onChange: (_event, name) => changes.push(name),
    onError: error => errors.push(error.code)
  })
  try {
    nodeFs.renameSync(inside, moved)
    nodeFs.symlinkSync(outside, inside)
    assert.equal(poller.poll(), -1)
    assert.deepEqual(changes, [])
    assert.deepEqual(errors, ['ESTALE'])
  } finally {
    poller.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('a native watcher rebound during registration cannot publish an outside filename', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'holo-watch-poll-'))
  const inside = path.join(base, 'inside')
  const moved = path.join(base, 'moved')
  const outside = path.join(base, 'outside')
  nodeFs.mkdirSync(inside)
  nodeFs.mkdirSync(outside)
  nodeFs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  const original = nodeFs.watch
  const watcher = new EventEmitter()
  watcher.close = () => {}
  const changes = []
  const errors = []
  let nativeCallback
  let source
  try {
    nodeFs.watch = (_target, _options, listener) => {
      nodeFs.renameSync(inside, moved)
      nodeFs.symlinkSync(outside, inside)
      nativeCallback = listener
      return watcher
    }
    source = createFsWatchSourceV1(inside, {
      directory: true,
      persistent: false,
      onChange: (event, filename) => changes.push([event, filename]),
      onError: error => errors.push(error.code)
    })
    nativeCallback('rename', 'secret.txt')
    assert.deepEqual(changes, [])
    assert.deepEqual(errors, ['ESTALE'])
  } finally {
    source?.close()
    nodeFs.watch = original
    await rm(base, { recursive: true, force: true })
  }
})
