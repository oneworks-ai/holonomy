import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- The addon needs real OS descriptors.
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { accessAt, accessDirectory, futimens, openAt, readDirectoryFd } from '../src/capability-fs-openat.mjs'

const { O_CREAT, O_DIRECTORY, O_EXCL, O_RDONLY, O_TRUNC, O_WRONLY } = fs.constants
const supported = process.platform === 'darwin' || process.platform === 'linux'

const withDirectory = run => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'holonomy-openat-'))
  const root = path.join(temporary, 'root')
  let rootFd
  try {
    fs.mkdirSync(root)
    rootFd = fs.openSync(root, O_RDONLY | O_DIRECTORY)
    return run({ root, rootFd, temporary })
  } finally {
    if (rootFd !== undefined) fs.closeSync(rootFd)
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

const withFd = (fd, run) => {
  try {
    return run(fd)
  } finally {
    fs.closeSync(fd)
  }
}

const isError = code => error =>
  error?.code === code &&
  Number.isInteger(error.errno) && error.errno > 0 &&
  error.message === 'Node filesystem openat failed'

test(
  'pinned futimens applies nanosecond metadata without opening a path again',
  { skip: !supported },
  () =>
    withDirectory(({ root, rootFd }) => {
      fs.writeFileSync(path.join(root, 'dated'), 'preserved')
      withFd(openAt(rootFd, 'dated', O_RDONLY), fd => {
        futimens(fd, { kind: 'set', seconds: 1_700_000_000, nanoseconds: 123_456_789 }, {
          kind: 'set',
          seconds: 1_700_000_001,
          nanoseconds: 987_654_321
        })
        const actual = fs.fstatSync(fd, { bigint: true })
        assert.equal(actual.atimeNs, 1_700_000_000_123_456_789n)
        assert.equal(actual.mtimeNs, 1_700_000_001_987_654_321n)
        assert.equal(fs.readFileSync(path.join(root, 'dated'), 'utf8'), 'preserved')
        assert.throws(
          () => futimens(fd, { kind: 'set', seconds: -1, nanoseconds: 0 }, { kind: 'omit' }),
          isError('EINVAL')
        )
      })
    })
)

test(
  'directory access checks the pinned directory object',
  { skip: !supported },
  () =>
    withDirectory(({ root, rootFd }) => {
      fs.mkdirSync(path.join(root, 'child'))
      withFd(openAt(rootFd, 'child', O_RDONLY | O_DIRECTORY), fd => {
        fs.renameSync(path.join(root, 'child'), path.join(root, 'moved'))
        fs.mkdirSync(path.join(root, 'child'))
        assert.doesNotThrow(() => accessDirectory(fd, fs.constants.X_OK))
        assert.throws(() => accessDirectory(fd, 8), isError('EINVAL'))
      })
    })
)

test(
  'descriptor-relative F_OK checks existence without read permission or side effects',
  { skip: !supported },
  () =>
    withDirectory(({ root, rootFd }) => {
      const target = path.join(root, 'opaque')
      fs.writeFileSync(target, 'preserved')
      fs.chmodSync(target, 0)
      try {
        const identity = accessAt(rootFd, 'opaque', 0)
        assert.equal(typeof identity.ino, 'string')
        assert.throws(() => accessAt(rootFd, 'opaque', fs.constants.R_OK), isError('EACCES'))
      } finally {
        fs.chmodSync(target, 0o600)
      }
      assert.equal(fs.readFileSync(target, 'utf8'), 'preserved')
    })
)

test(
  'directory snapshot rejects a non-UTF-8 raw name before publishing entries',
  { skip: process.platform !== 'linux' },
  () =>
    withDirectory(({ root, rootFd }) => {
      const rawPath = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xFF])])
      fs.writeFileSync(rawPath, 'x')
      try {
        assert.throws(() => readDirectoryFd(rootFd, 16), isError('EILSEQ'))
      } finally {
        fs.unlinkSync(rawPath)
      }
    })
)

test(
  'directory fd walk opens only the requested regular leaf',
  { skip: !supported },
  () =>
    withDirectory(({ root, rootFd }) => {
      fs.mkdirSync(path.join(root, 'child'))
      fs.writeFileSync(path.join(root, 'child', 'data'), 'inside')
      withFd(openAt(rootFd, 'child', O_RDONLY | O_DIRECTORY), childFd => {
        assert.equal(fs.fstatSync(childFd).isDirectory(), true)
        withFd(openAt(childFd, 'data', O_RDONLY), dataFd => {
          assert.equal(fs.readFileSync(dataFd, 'utf8'), 'inside')
        })
      })
      assert.throws(() => openAt(rootFd, 'child', O_RDONLY), isError('EISDIR'))
    })
)

test(
  'leaf symlink cannot reach outside and truncation flags cannot mutate',
  { skip: !supported },
  () =>
    withDirectory(({ root, rootFd, temporary }) => {
      const outside = path.join(temporary, 'outside')
      fs.writeFileSync(outside, 'outside bytes')
      fs.symlinkSync(outside, path.join(root, 'alias'))
      assert.throws(() => openAt(rootFd, 'alias', O_WRONLY), isError('ELOOP'))
      assert.equal(fs.readFileSync(outside, 'utf8'), 'outside bytes')

      fs.writeFileSync(path.join(root, 'victim'), 'victim bytes')
      assert.throws(() => openAt(rootFd, 'victim', O_WRONLY | O_TRUNC), isError('EINVAL'))
      assert.equal(fs.readFileSync(path.join(root, 'victim'), 'utf8'), 'victim bytes')
    })
)

test('FIFO is rejected quickly without a blocking open', { skip: !supported }, () =>
  withDirectory(({ root }) => {
    const fifo = path.join(root, 'fifo')
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' })
    assert.equal(created.status, 0, created.stderr)
    const loaderUrl = new URL('../src/capability-fs-openat.mjs', import.meta.url).href
    const script = `
    import fs from 'node:fs'
    const { openAt } = await import(process.argv[1])
    const parent = fs.openSync(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    try {
      try {
        openAt(parent, 'fifo', fs.constants.O_RDONLY)
        process.exitCode = 2
      } catch (error) {
        if (error.code !== 'EINVAL') process.exitCode = 3
      }
    } finally {
      fs.closeSync(parent)
    }
  `
    const started = performance.now()
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, loaderUrl, root], {
      encoding: 'utf8',
      timeout: 2000
    })
    assert.equal(child.signal, null, child.stderr)
    assert.equal(child.status, 0, child.stderr)
    assert.ok(performance.now() - started < 2000)
  }))

test(
  'exclusive create is atomic and creation mode cannot be widened',
  { skip: !supported },
  () =>
    withDirectory(({ root, rootFd }) => {
      withFd(openAt(rootFd, 'created', O_WRONLY | O_CREAT | O_EXCL), fd => {
        fs.writeSync(fd, 'created bytes')
      })
      assert.equal(fs.readFileSync(path.join(root, 'created'), 'utf8'), 'created bytes')
      assert.equal(fs.statSync(path.join(root, 'created')).mode & 0o777 & ~0o600, 0)
      assert.throws(() => openAt(rootFd, 'created', O_WRONLY | O_CREAT | O_EXCL), isError('EEXIST'))
      assert.throws(() => openAt(rootFd, 'other', O_WRONLY | O_CREAT | O_EXCL, 0o666), isError('EINVAL'))
      assert.equal(fs.existsSync(path.join(root, 'other')), false)
    })
)

test(
  'one-segment names and directory parents are enforced',
  { skip: !supported },
  () =>
    withDirectory(({ root, rootFd }) => {
      for (const leaf of ['', '.', '..', 'a/b', 'a\0b', '\uD800', '\uDC00']) {
        assert.throws(() => openAt(rootFd, leaf, O_RDONLY), isError('EINVAL'))
      }
      assert.throws(() => openAt(rootFd, 'x'.repeat(256), O_RDONLY), isError('ENAMETOOLONG'))
      fs.writeFileSync(path.join(root, '🙂'), 'utf8 leaf')
      withFd(openAt(rootFd, '🙂', O_RDONLY), unicodeFd => {
        assert.equal(fs.readFileSync(unicodeFd, 'utf8'), 'utf8 leaf')
      })
      fs.writeFileSync(path.join(root, 'file'), 'x')
      withFd(openAt(rootFd, 'file', O_RDONLY), fileFd => {
        assert.throws(() => openAt(fileFd, 'child', O_RDONLY), isError('ENOTDIR'))
      })
    })
)

test(
  'renamed directory fd stays anchored to its original object',
  { skip: !supported },
  () =>
    withDirectory(({ root, rootFd }) => {
      const original = path.join(root, 'original')
      const moved = path.join(root, 'moved')
      fs.mkdirSync(original)
      fs.writeFileSync(path.join(original, 'leaf'), 'original object')
      withFd(openAt(rootFd, 'original', O_RDONLY | O_DIRECTORY), anchoredFd => {
        fs.renameSync(original, moved)
        fs.mkdirSync(original)
        fs.writeFileSync(path.join(original, 'leaf'), 'replacement object')
        withFd(openAt(anchoredFd, 'leaf', O_RDONLY), leafFd => {
          assert.equal(fs.readFileSync(leafFd, 'utf8'), 'original object')
        })
      })
      assert.equal(fs.readFileSync(path.join(original, 'leaf'), 'utf8'), 'replacement object')
    })
)

test('other platforms report ENOSYS', { skip: supported }, () => {
  assert.throws(() => openAt(0, 'leaf', O_RDONLY), error =>
    error?.code === 'ENOSYS' &&
    Number.isInteger(error.errno) && error.errno > 0 &&
    error.message === 'Node filesystem openat failed')
})

test('Host loader reports fixed unavailability when its built addon is absent', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'holonomy-openat-loader-'))
  try {
    const source = fileURLToPath(new URL('../src/capability-fs-openat.mjs', import.meta.url))
    const copied = path.join(temporary, 'src', 'capability-fs-openat.mjs')
    fs.mkdirSync(path.dirname(copied))
    fs.copyFileSync(source, copied)
    const isolated = await import(pathToFileURL(copied).href)
    assert.throws(() => isolated.openAt(0, 'leaf', O_RDONLY), error =>
      error?.code === 'ENOSYS' &&
      Number.isInteger(error.errno) && error.errno > 0 &&
      error.message === 'Node filesystem openat unavailable')
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
