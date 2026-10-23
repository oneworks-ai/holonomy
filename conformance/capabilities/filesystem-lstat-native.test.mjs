import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { test } from 'node:test'

const path = name => `holo-fs://workspace/${name}`

export const registerFilesystemLstatTests = ({ withinRoot }) => {
  test('lstatSync returns ordinary file metadata', () => {
    const info = fs.lstatSync(path('real/file'))
    assert.equal(info.isFile(), true)
    assert.equal(info.isSymbolicLink(), false)
    assert.equal(info.size, 8)
  })

  test('promise lstat returns directory metadata', async () => {
    const info = await fsp.lstat(path('real'))
    assert.equal(info.isDirectory(), true)
    assert.equal(info.isSymbolicLink(), false)
  })

  test('callback lstat returns the same file through the public API', async () => {
    const info = await new Promise((resolve, reject) => {
      fs.lstat(path('real/file'), (error, value) => error ? reject(error) : resolve(value))
    })
    assert.equal(info.isFile(), true)
    assert.equal(info.size, 8)
  })

  test('missing lstat reports the stable public error', async () => {
    assert.throws(() => fs.lstatSync(path('missing')), { code: 'ENOENT' })
    await assert.rejects(fsp.lstat(path('missing')), { code: 'ENOENT' })
  })

  if (withinRoot) {
    test('lstat resolves only the parent directory alias', async () => {
      const info = await fsp.lstat(path('alias/file'))
      assert.equal(info.isFile(), true)
      assert.equal(info.size, 8)
    })

    test('lstat rejects final internal, external and broken symlinks', async () => {
      for (const name of ['file-link', 'dir-link', 'external-link', 'broken-link']) {
        assert.throws(() => fs.lstatSync(path(name)), { code: 'EIO' })
        await assert.rejects(fsp.lstat(path(name)), { code: 'EIO' })
      }
    })
  } else {
    test('deny profile retains its rejection of parent aliases', () => {
      assert.throws(() => fs.lstatSync(path('alias/file')), { code: 'EXDEV' })
    })

    test('deny profile retains metadata for final links including broken links', () => {
      for (const name of ['file-link', 'dir-link', 'external-link', 'broken-link']) {
        assert.equal(fs.lstatSync(path(name)).isSymbolicLink(), true)
      }
    })
  }
}
