import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { describe, it } from 'node:test'

const path = name => `holo-fs://workspace/${name}`
const permissions = stats => stats.mode & 0o777

export const registerFilesystemModeTests = ({ allowChmod }) => {
  describe('Explicit filesystem chmod authority', () => {
    if (!allowChmod) {
      it('does not derive chmod authority from write permission or a writable fd', async () => {
        assert.equal(typeof fs.chmodSync, 'function')
        await assert.rejects(async () => fsp.chmod(path('denied.txt'), 0o777), error => error.code === 'EACCES')
        assert.throws(() => fs.chmodSync(path('denied.txt'), 0o777), error => error.code === 'EACCES')
        const fd = fs.openSync(path('denied.txt'), 'r+')
        try {
          assert.throws(() => fs.fchmodSync(fd, 0o777), error => error.code === 'EACCES')
        } finally {
          fs.closeSync(fd)
        }
        assert.equal(permissions(await fsp.stat(path('denied.txt'))), 0o640)
      })
      return
    }

    it('changes real path permissions and reports the file type without changing bytes', async () => {
      assert.equal(await fsp.chmod(path('promise.txt'), '640'), undefined)
      const stats = await fsp.stat(path('promise.txt'))
      assert.equal(typeof stats.mode, 'number')
      assert.equal(stats.mode & 0o170000, 0o100000)
      assert.equal(permissions(stats), 0o640)
      assert.equal(await fsp.readFile(path('promise.txt'), 'utf8'), 'UNCHANGED')
    })

    it('uses fresh metadata authority on a read-only virtual fd without granting data writes', () => {
      const fd = fs.openSync(path('sync-fd.txt'), 'r')
      try {
        assert.equal(fs.fchmodSync(fd, 0o600), undefined)
        assert.throws(() => fs.ftruncateSync(fd, 0), error => error.code === 'EACCES')
        assert.equal(fs.readFileSync(fd, 'utf8'), 'UNCHANGED')
      } finally {
        fs.closeSync(fd)
      }
      assert.equal(permissions(fs.statSync(path('sync-fd.txt'))), 0o600)
    })

    it('delivers chmod callback success and missing-path failure with one argument', async () => {
      assert.equal(fs.chmodSync(path('callback.txt'), 0o600), undefined)
      await new Promise((resolve, reject) =>
        fs.chmod(path('callback.txt'), 0o644, (...args) => {
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
        fs.chmod(path('missing.txt'), 0o644, (...args) => {
          try {
            assert.equal(args.length, 1)
            assert.equal(args[0].code, 'ENOENT')
            resolve()
          } catch (error) {
            reject(error)
          }
        })
      )
      assert.equal(permissions(await fsp.stat(path('callback.txt'))), 0o644)
    })

    it('restores mode through the original FileHandle after removing pathname access', async () => {
      const file = await fsp.open(path('restore.txt'), 'r')
      try {
        assert.equal(await file.chmod(0), undefined)
        assert.equal(await file.chmod('600'), undefined)
        assert.equal(permissions(await file.stat()), 0o600)
        assert.equal(await file.readFile('utf8'), 'UNCHANGED')
      } finally {
        await file.close()
      }
    })

    it('changes a directory without changing its type', async () => {
      assert.equal(await fsp.chmod(path('directory'), '750'), undefined)
      const stats = await fsp.stat(path('directory'))
      assert.equal(stats.isDirectory(), true)
      assert.equal(stats.mode & 0o170000, 0o040000)
      assert.equal(permissions(stats), 0o750)
    })

    it('keeps fchmod on the original inode after a pathname replacement', async () => {
      const file = await fsp.open(path('bound.txt'), 'r')
      try {
        await fsp.rename(path('bound.txt'), path('bound-original.txt'))
        await fsp.writeFile(path('bound.txt'), 'REPLACEMENT')
        await fsp.chmod(path('bound.txt'), 0o640)
        assert.equal(await file.chmod(0o644), undefined)
        assert.equal(permissions(await fsp.stat(path('bound-original.txt'))), 0o644)
        assert.equal(permissions(await fsp.stat(path('bound.txt'))), 0o640)
        assert.equal(await file.readFile('utf8'), 'UNCHANGED')
      } finally {
        await file.close()
      }
    })

    it('rejects special bits, type bits and coercion before permissions change', async () => {
      let effects = 0
      const value = new Proxy({}, {
        get() {
          effects++
          throw new Error('No Guest coercion')
        },
        getPrototypeOf() {
          effects++
          throw new Error('No Guest prototype lookup')
        }
      })
      for (const mode of [0o4644, 0o2644, 0o1644, 0o100644, -1, 512, Number.NaN, Infinity, '8', '0o644', value]) {
        await assert.rejects(async () => fsp.chmod(path('invalid.txt'), mode), error => error.code === 'EINVAL')
        assert.equal(permissions(await fsp.stat(path('invalid.txt'))), 0o640)
      }
      assert.equal(effects, 0)
    })

    it('does not turn an executable mode bit into execution authority', async () => {
      assert.equal(await fsp.chmod(path('executable.txt'), 0o755), undefined)
      assert.equal(permissions(await fsp.stat(path('executable.txt'))), 0o755)
      await assert.rejects(async () => fsp.access(path('executable.txt'), 1), error => error.code === 'EACCES')
    })

    it('lets Host middleware refuse a policy-allowed mode change before the effect', async () => {
      await assert.rejects(async () => fsp.chmod(path('host-denied.txt'), 0o777), error => error.code === 'EACCES')
      assert.throws(() => fs.chmodSync(path('host-denied.txt'), 0o777), error => error.code === 'EACCES')
      assert.equal(permissions(await fsp.stat(path('host-denied.txt'))), 0o640)
    })
  })
}
