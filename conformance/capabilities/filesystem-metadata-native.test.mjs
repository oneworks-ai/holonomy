import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { test } from 'node:test'

const path = name => `holo-fs://workspace/${name}`

test('updates exact file times without changing file contents', async () => {
  assert.equal(await fsp.utimes(path('times.txt'), 1_234_567_889.5, '1234567890.125'), undefined)
  const stats = await fsp.stat(path('times.txt'))
  assert.equal(stats.atimeMs, 1_234_567_889_500)
  assert.equal(stats.mtimeMs, 1_234_567_890_125)
  assert.equal('atimeNs' in stats, false)
  assert.equal('mtimeNs' in stats, false)
  assert.equal(await fsp.readFile(path('times.txt'), 'utf8'), 'PRESERVED')
})

test('truncates and syncs the same writable FileHandle with void results', async () => {
  const file = await fsp.open(path('handle.txt'), 'r+')
  try {
    assert.equal(await file.utimes(1000.25, 2000.5), undefined)
    const changed = await file.stat()
    assert.equal(changed.mtimeMs, 2_000_500)
    assert.equal('mtimeNs' in changed, false)
    assert.equal(await file.truncate(4), undefined)
    assert.equal(await file.sync(), undefined)
    assert.equal(await file.datasync(), undefined)
    assert.equal((await file.stat()).size, 4)
    assert.equal(await file.readFile('utf8'), 'HAND')
  } finally {
    await file.close()
  }
})

test('keeps sync virtual-fd metadata operations on the opened object', () => {
  const fd = fs.openSync(path('sync.txt'), 'r+')
  try {
    assert.equal(fs.futimesSync(fd, 3000.125, 4000.25), undefined)
    assert.equal(fs.ftruncateSync(fd, 2), undefined)
    assert.equal(fs.fsyncSync(fd), undefined)
    assert.equal(fs.fdatasyncSync(fd), undefined)
    assert.equal(fs.statSync(path('sync.txt')).size, 2)
  } finally {
    fs.closeSync(fd)
  }
  assert.equal(fs.readFileSync(path('sync.txt'), 'utf8'), 'SY')
})

test('delivers callback metadata success and failure with exact single arguments', async () => {
  await new Promise((resolve, reject) =>
    fs.utimes(path('callback.txt'), 5000, 6000, (...args) => {
      try {
        assert.equal(args.length, 1)
        assert.equal(args[0], null)
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  )
  await new Promise((resolve, reject) =>
    fs.utimes(path('missing.txt'), 5000, 6000, (...args) => {
      try {
        assert.equal(args.length, 1)
        assert.equal(args[0].code, 'ENOENT')
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  )
})

test('allows real sync on a read-only file handle and refuses mutation', async () => {
  const file = await fsp.open(path('readonly.txt'), 'r')
  try {
    assert.equal(await file.sync(), undefined)
    assert.equal(await file.datasync(), undefined)
    await assert.rejects(async () => file.truncate(0), error => error.code === 'EACCES')
    assert.equal(await file.readFile('utf8'), 'READ_ONLY')
  } finally {
    await file.close()
  }
})

test('checks access and preserves missing-path errors', async () => {
  assert.equal(fs.accessSync(path('times.txt'), 0), undefined)
  assert.equal(await fsp.access(path('times.txt'), 6), undefined)
  await assert.rejects(async () => fsp.access(path('missing.txt'), 0), error => error.code === 'ENOENT')
})

test('updates owner timestamps on write-only and read-only physical files', async () => {
  for (const name of ['write-only-time.txt', 'read-only-time.txt']) {
    assert.equal(await fsp.utimes(path(name), 1_234_000.25, 1_234_001.5), undefined)
  }
})

test('rejects an over-limit truncate before content changes', async () => {
  await assert.rejects(async () => fsp.truncate(path('bounded.txt'), 4097), error => error.code === 'EFBIG')
  assert.equal(await fsp.readFile(path('bounded.txt'), 'utf8'), 'KEEP_BOUNDED')
})

test('refuses unsupported time objects without invoking Guest traps or coercion', async () => {
  let effects = 0
  const value = new Proxy({}, {
    get() {
      effects++
      throw new Error('Guest get must not run')
    },
    getPrototypeOf() {
      effects++
      throw new Error('Guest prototype trap must not run')
    }
  })
  await assert.rejects(async () => fsp.utimes(path('bounded.txt'), value, 1))
  assert.equal(effects, 0)
  await assert.rejects(async () => fsp.utimes(path('bounded.txt'), { kind: 'now' }, 1))
  assert.equal(await fsp.readFile(path('bounded.txt'), 'utf8'), 'KEEP_BOUNDED')
})
