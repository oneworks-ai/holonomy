import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { describe, it } from 'node:test'

// The virtual workspace intentionally persists across Runtime restarts. Keep
// the fixture path stable and make each assertion safe to repeat.
const root = 'holo-fs://workspace/fs-v1'
const pathExists = path => {
  try {
    fs.statSync(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
const callback = start =>
  new Promise((resolve, reject) => {
    start(function(error, value) {
      if (error) reject(error)
      else resolve({ arity: arguments.length, value })
    })
  })
const callbackError = start =>
  new Promise(resolve => {
    start(function(error) {
      resolve({ arity: arguments.length, code: error?.code, name: error?.name })
    })
  })

// The event is the readiness evidence; the deadline only bounds failure.
// Repeated writes stimulate the watcher without assuming when the OS is ready.
const watchDeadline = async (label, run, details = () => ({})) => {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: ${JSON.stringify(details())}`)), 2000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
let watchSequence = 0
const watchEvent = async (directory, subscribe) => {
  const filename = `probe-${Date.now()}-${++watchSequence}.txt`
  const target = `${directory}/${filename}`
  let lastEvent
  let writes = 0
  let writer
  let dispose
  try {
    return await watchDeadline(
      'Filesystem watch did not deliver the target event',
      () =>
        new Promise((resolve, reject) => {
          dispose = subscribe(
            (type, observedName) => {
              lastEvent = { filename: observedName, type }
              // Node permits a missing watch filename. A directory-level
              // polling fallback may only report that something changed.
              if (observedName !== filename && (observedName !== null || !pathExists(target))) return false
              resolve(lastEvent)
              return true
            },
            reject,
            filename
          )
          const write = () => {
            try {
              fs.writeFileSync(target, `watch-${writes++}`)
            } catch (error) {
              reject(error)
            }
          }
          writer = setInterval(write, 250)
          write()
        }),
      () => ({ expectedFilename: filename, lastEvent, writes })
    )
  } finally {
    clearInterval(writer)
    await dispose?.()
    if (pathExists(target)) fs.unlinkSync(target)
  }
}

const unsupportedFsExports = [
  'appendFile',
  'appendFileSync',
  'chown',
  'chownSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'createReadStream',
  'createWriteStream',
  'fchown',
  'fchownSync',
  'fstat',
  'fstatSync',
  'lchmod',
  'lchmodSync',
  'lchown',
  'lchownSync',
  'link',
  'linkSync',
  'lutimes',
  'lutimesSync',
  'mkdtemp',
  'mkdtempSync',
  'opendir',
  'opendirSync',
  'read',
  'readSync',
  'readdirSyncRecursive',
  'readlink',
  'readlinkSync',
  'readv',
  'readvSync',
  'realpath',
  'realpathSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'symlink',
  'symlinkSync',
  'write',
  'writeSync',
  'writev',
  'writevSync'
]

const unsupportedPromiseFsExports = [
  'appendFile',
  'chown',
  'copyFile',
  'cp',
  'lchmod',
  'lchown',
  'link',
  'lutimes',
  'mkdtemp',
  'opendir',
  'readlink',
  'realpath',
  'rm',
  'rmdir',
  'symlink'
]

describe('Filesystem Provider v1', () => {
  it('implements the declared synchronous path, fd and metadata surface', () => {
    const directory = fs.mkdirSync(`${root}/sync/deep`, { recursive: true })
    assert.ok(directory == null || directory.startsWith('holo-fs://workspace/'))
    const recursiveParent = `${root}/mkdir-parent`
    const recursiveFirst = `${recursiveParent}/first`
    const recursiveSecond = `${recursiveFirst}/second`
    fs.mkdirSync(recursiveParent, { recursive: true })
    const firstAlreadyExists = pathExists(recursiveFirst)
    const secondAlreadyExists = pathExists(recursiveSecond)
    assert.equal(
      fs.mkdirSync(recursiveSecond, { recursive: true }),
      firstAlreadyExists
        ? secondAlreadyExists
          ? undefined
          : recursiveSecond
        : recursiveFirst
    )
    fs.writeFileSync(`${root}/sync/deep/value.txt`, new Uint8Array([104, 105]))
    const readFd = fs.openSync(`${root}/sync/deep/value.txt`, 'r')
    assert.equal(fs.readFileSync(readFd, 'utf8'), 'hi')
    fs.closeSync(readFd)
    const writeFd = fs.openSync(`${root}/sync/deep/fd.txt`, 'w+')
    fs.writeFileSync(writeFd, 'fd-value', 'utf8')
    fs.closeSync(writeFd)
    assert.equal(fs.readFileSync(`${root}/sync/deep/fd.txt`, 'utf8'), 'fd-value')
    fs.renameSync(`${root}/sync/deep/value.txt`, `${root}/sync/deep/moved.txt`)
    assert.equal(fs.statSync(`${root}/sync/deep/moved.txt`).isFile(), true)
    assert.equal(fs.lstatSync(`${root}/sync/deep/moved.txt`).isFile(), true)
    assert.deepEqual(fs.readdirSync(`${root}/sync/deep`).sort(), ['fd.txt', 'moved.txt'])
    assert.deepEqual(
      fs.readdirSync(`${root}/sync/deep`, { withFileTypes: true }).map(item => [item.name, item.isFile()]).sort(),
      [['fd.txt', true], ['moved.txt', true]]
    )
    fs.unlinkSync(`${root}/sync/deep/fd.txt`)
    fs.unlinkSync(`${root}/sync/deep/moved.txt`)
  })

  it('preserves every callback success tuple and callback AbortError', async () => {
    const mkdir = await callback(done => fs.mkdir(`${root}/callback`, { recursive: true }, done))
    const write = await callback(done => fs.writeFile(`${root}/callback/value.txt`, 'callback-value', done))
    const read = await callback(done => fs.readFile(`${root}/callback/value.txt`, 'utf8', done))
    const open = await callback(done => fs.open(`${root}/callback/value.txt`, 'r', done))
    assert.equal(fs.readFileSync(open.value, 'utf8'), 'callback-value')
    const close = await callback(done => fs.close(open.value, done))
    const stat = await callback(done => fs.stat(`${root}/callback/value.txt`, done))
    const lstat = await callback(done => fs.lstat(`${root}/callback/value.txt`, done))
    const readdir = await callback(done => fs.readdir(`${root}/callback`, { withFileTypes: true }, done))
    const rename = await callback(done =>
      fs.rename(
        `${root}/callback/value.txt`,
        `${root}/callback/moved.txt`,
        done
      )
    )
    const controller = new AbortController()
    controller.abort()
    const abort = await callbackError(done =>
      fs.readFile(
        `${root}/callback/moved.txt`,
        { encoding: 'utf8', signal: controller.signal },
        done
      )
    )
    const unlink = await callback(done => fs.unlink(`${root}/callback/moved.txt`, done))
    assert.deepEqual(
      [
        mkdir.arity,
        write.arity,
        read.arity,
        open.arity,
        close.arity,
        stat.arity,
        lstat.arity,
        readdir.arity,
        rename.arity,
        unlink.arity
      ],
      [2, 1, 2, 2, 1, 2, 2, 2, 1, 1]
    )
    assert.equal(read.value, 'callback-value')
    assert.equal(stat.value.isFile() && lstat.value.isFile(), true)
    assert.deepEqual(readdir.value.map(item => [item.name, item.isFile()]), [['value.txt', true]])
    assert.deepEqual(abort, { arity: 1, code: 'ABORT_ERR', name: 'AbortError' })
  })

  it('implements Promise path, FileHandle and AsyncIterator variants', async () => {
    await fsp.mkdir(`${root}/promise`, { recursive: true })
    await fsp.writeFile(`${root}/promise/value.txt`, 'before')
    const readHandle = await fsp.open(`${root}/promise/value.txt`, 'r')
    assert.equal(await readHandle.readFile('utf8'), 'before')
    await readHandle.close()
    const writeHandle = await fsp.open(`${root}/promise/value.txt`, 'w+')
    await writeHandle.writeFile('after')
    assert.equal((await writeHandle.stat()).size, 5)
    await writeHandle.close()
    assert.equal((await fsp.lstat(`${root}/promise/value.txt`)).isFile(), true)
    assert.deepEqual(
      (await fsp.readdir(`${root}/promise`, { withFileTypes: true })).map(item => [item.name, item.isFile()]),
      [['value.txt', true]]
    )
    await fsp.rename(`${root}/promise/value.txt`, `${root}/promise/moved.txt`)
    assert.equal((await fsp.stat(`${root}/promise/moved.txt`)).isFile(), true)
    assert.equal(await fsp.readFile(`${root}/promise/moved.txt`, 'utf8'), 'after')
    const event = await watchEvent(`${root}/promise`, (accept, reject) => {
      const iterator = fsp.watch(`${root}/promise`, { maxQueuedEvents: 1, persistent: false })
      const read = async () => {
        try {
          assert.equal(iterator.maxQueuedEvents, 1)
          while (true) {
            const next = await iterator.next()
            assert.equal(next.done, false)
            if (accept(next.value.eventType, next.value.filename)) return
          }
        } catch (error) {
          reject(error)
        }
      }
      void read()
      return () => iterator.return()
    })
    assert.ok(['change', 'rename'].includes(event.type))
    await fsp.unlink(`${root}/promise/moved.txt`)
  })

  it('enforces Abort, handle, byte, atomic and unsupported boundaries', async () => {
    fs.writeFileSync(`${root}/limits.txt`, 'before')
    const closedFd = fs.openSync(`${root}/limits.txt`, 'r')
    fs.closeSync(closedFd)
    assert.throws(() => fs.readFileSync(closedFd), error => error?.code === 'EBADF')
    const handles = []
    try {
      assert.throws(() => {
        for (let index = 0; index < 9; index += 1) handles.push(fs.openSync(`${root}/limits.txt`, 'r'))
      }, error => error?.code === 'EMFILE')
    } finally {
      for (const handle of handles) fs.closeSync(handle)
    }
    assert.throws(
      () => fs.writeFileSync(`${root}/oversize.txt`, 'x'.repeat(4097)),
      error => error?.code === 'EFBIG'
    )
    let exclusiveError
    try {
      fs.writeFileSync(`${root}/limits.txt`, 'after', { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      exclusiveError = error
    }
    assert.equal(
      exclusiveError?.code,
      'EEXIST',
      JSON.stringify({
        code: exclusiveError?.code,
        message: exclusiveError?.message,
        name: exclusiveError?.name
      })
    )
    assert.equal(fs.readFileSync(`${root}/limits.txt`, 'utf8'), 'before')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      fsp.writeFile(`${root}/aborted.txt`, 'leaked', { signal: controller.signal }),
      error => error?.code === 'ABORT_ERR' && error?.name === 'AbortError'
    )
    assert.throws(() => fs.readFileSync(`${root}/aborted.txt`), error => error?.code === 'ENOENT')
    for (
      const member of ['access', 'utimes', 'futimes', 'truncate', 'ftruncate', 'fsync', 'fdatasync', 'chmod', 'fchmod']
    ) {
      assert.equal(typeof fs[member], 'function')
      assert.equal(typeof fs[`${member}Sync`], 'function')
    }
    for (const member of ['access', 'utimes', 'truncate']) assert.equal(typeof fsp[member], 'function')
    assert.deepEqual(
      unsupportedFsExports.filter(name => typeof fs[name] !== 'undefined'),
      []
    )
    assert.deepEqual(
      unsupportedPromiseFsExports.filter(name => typeof fsp[name] !== 'undefined'),
      []
    )
    fs.unlinkSync(`${root}/limits.txt`)
  })

  it('delivers callback watcher events and exposes the admitted queue limit', async () => {
    fs.mkdirSync(`${root}/watch`, { recursive: true })
    const event = await watchEvent(`${root}/watch`, (accept, reject, expectedFilename) => {
      const watcher = fs.watch(`${root}/watch`, { maxQueuedEvents: 1, persistent: false }, (type, filename) => {
        if (filename === expectedFilename || filename === null) {
          try {
            watcher.close()
          } catch (error) {
            reject(error)
            return
          }
        }
        accept(type, filename)
      })
      watcher.on('error', reject)
      try {
        assert.equal(watcher.maxQueuedEvents, 1)
      } catch (error) {
        watcher.close()
        throw error
      }
      return () => watcher.close()
    })
    assert.ok(['change', 'rename'].includes(event.type))
  })

  // Queue overflow is deterministic at the controlled Guest resource-event seam:
  // __tests__/js-runtime-kernel/capability-runtime/guest-fs-watch.spec.ts.
  // OS callback counts/timing cannot establish that a queue has overflowed.
  it('settles pending and subsequent Promise watcher reads on return and abort', async () => {
    fs.mkdirSync(`${root}/terminal`, { recursive: true })
    const iterator = fsp.watch(`${root}/terminal`, { maxQueuedEvents: 1, persistent: false })
    try {
      await watchDeadline('Filesystem watch return did not settle', async () => {
        const pending = iterator.next()
        assert.equal((await iterator.return()).done, true)
        assert.equal((await pending).done, true)
        assert.equal((await iterator.next()).done, true)
        assert.equal((await iterator.return()).done, true)
      })
    } finally {
      await iterator.return()
    }
    const controller = new AbortController()
    const aborted = fsp.watch(`${root}/terminal`, {
      maxQueuedEvents: 1,
      persistent: false,
      signal: controller.signal
    })
    try {
      await watchDeadline('Filesystem watch abort did not settle', async () => {
        const pending = aborted.next()
        controller.abort()
        const isAbort = error => error?.code === 'ABORT_ERR' && error?.name === 'AbortError'
        await assert.rejects(pending, isAbort)
        await assert.rejects(aborted.next(), isAbort)
      })
    } finally {
      await aborted.return()
    }
  })
})
