import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { describe, it } from 'node:test'

const run = (executableId, args) =>
  new Promise(resolve => {
    execFile(executableId, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      const result = { code: error?.code ?? 0, stdout, stderr }
      console.log(`V86_FILESYSTEM_TOOL:${JSON.stringify({ executableId, args, ...result })}`)
      resolve(result)
    })
  })

export const registerNativeProcessFilesystemTests = ({ readOnly }) => {
  describe(`Native Linux filesystem tools ${readOnly ? 'read-only' : 'read-write'}`, () => {
    it('reads an existing Host file through the pinned Linux cat', async () => {
      assert.deepEqual(await run('cat', ['/workspace/source.txt']), {
        code: 0,
        stdout: 'SOURCE_CONTENT\n',
        stderr: ''
      })
    })

    it('preserves Host filenames containing spaces, Unicode and literal percent sequences', async () => {
      assert.deepEqual(
        await run('cat', [
          '/workspace/a b.txt',
          '/workspace/中😀.txt',
          '/workspace/%2F.txt'
        ]),
        { code: 0, stdout: 'SPACE\nUNICODE\nLITERAL_PERCENT\n', stderr: '' }
      )
    })

    if (readOnly) {
      it('denies a Linux copy without a Process mount write right', async () => {
        const result = await run('cp', ['/workspace/source.txt', '/workspace/denied.txt'])
        assert.ok(Number.isInteger(result.code) && result.code > 0)
        assert.equal(result.stdout, '')
        assert.match(result.stderr, /Permission denied|Operation not permitted/u)
      })
      return
    }

    it('runs mkdir, cp, cat, mv and rm against Host-owned files', async () => {
      assert.deepEqual(await run('mkdir', ['/workspace/sub']), { code: 0, stdout: '', stderr: '' })
      assert.deepEqual(await run('cp', ['/workspace/source.txt', '/workspace/target.txt']), {
        code: 0,
        stdout: '',
        stderr: ''
      })
      assert.deepEqual(await run('cat', ['/workspace/target.txt']), {
        code: 0,
        stdout: 'SOURCE_CONTENT\n',
        stderr: ''
      })
      assert.deepEqual(await run('mv', ['/workspace/target.txt', '/workspace/sub/moved.txt']), {
        code: 0,
        stdout: '',
        stderr: ''
      })
      assert.deepEqual(await run('rm', ['/workspace/sub/moved.txt']), {
        code: 0,
        stdout: '',
        stderr: ''
      })
    })

    it('preserves an existing file during a nontruncating dd write', async () => {
      const written = await run('dd', [
        'if=/dev/zero',
        'of=/workspace/flag-target.txt',
        'bs=1',
        'count=1',
        'conv=notrunc'
      ])
      assert.equal(written.code, 0, written.stderr)
      const result = await run('cat', ['/workspace/flag-target.txt'])
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout, '\0RESERVED_SUFFIX\n')
    })

    it('appends through an existing FUSE handle regardless of the Guest write offset', async () => {
      const written = await run('sh', ['-c', 'printf APPEND >> /workspace/append-target.txt'])
      assert.deepEqual(written, { code: 0, stdout: '', stderr: '' })
      const result = await run('cat', ['/workspace/append-target.txt'])
      assert.deepEqual(result, { code: 0, stdout: 'PREFIXAPPEND', stderr: '' })
    })

    it('updates an existing file with touch without changing its bytes', async () => {
      const touched = await run('touch', ['/workspace/touch-target.txt'])
      assert.deepEqual(touched, { code: 0, stdout: '', stderr: '' })
      assert.deepEqual(await run('cat', ['/workspace/touch-target.txt']), {
        code: 0,
        stdout: 'TOUCH_MUST_PRESERVE\n',
        stderr: ''
      })
    })

    it('enumerates a real directory through the retained directory resource', async () => {
      assert.deepEqual(await run('ls', ['-1', '/workspace/listing']), {
        code: 0,
        stdout: 'a.txt\nb.txt\n',
        stderr: ''
      })
    })

    it('syncs file and directory descriptors but preserves a Host denial', async () => {
      assert.deepEqual(await run('busybox', ['sync', '-d', '/workspace/source.txt']), {
        code: 0,
        stdout: '',
        stderr: ''
      })
      assert.deepEqual(await run('busybox', ['sync', '/workspace/listing']), {
        code: 0,
        stdout: '',
        stderr: ''
      })
      const denied = await run('busybox', ['sync', '/workspace/blocked-sync'])
      assert.ok(Number.isInteger(denied.code) && denied.code > 0)
      assert.equal(denied.stdout, '')
      assert.match(denied.stderr, /Permission denied|Operation not permitted/u)
    })
    it('initializes and reports an empty Git repository', async () => {
      const init = await run('git', ['init', '/workspace/git-probe'])
      assert.equal(init.code, 0, init.stderr)
      const status = await run('git', ['-C', '/workspace/git-probe', 'status', '--short'])
      assert.deepEqual(status, { code: 0, stdout: '', stderr: '' })
    })
  })
}

export const registerNativeProcessFilesystemReleaseTests = () => {
  it('reuses one Host handle slot while the same Linux process reads files and enumerates directories', async () => {
    const command = `
      for n in 1 2 3 4 5 6 7 8; do
        exec 3< /workspace/source.txt || exit 11
        IFS= read -r line <&3 || exit 12
        [ "$line" = SOURCE_CONTENT ] || exit 13
        exec 3<&- || exit 14
        set -- /workspace/listing/*
        [ "$#" -eq 2 ] || exit 15
        [ "$1" = /workspace/listing/a.txt ] || exit 16
        [ "$2" = /workspace/listing/b.txt ] || exit 17
      done
      printf 'RELEASE_LOOP_OK:%s\\n' "$$"
    `
    const result = await run('sh', ['-c', command])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^RELEASE_LOOP_OK:[1-9]\d*\n$/u)
    assert.equal(result.stderr, '')
  })
}
