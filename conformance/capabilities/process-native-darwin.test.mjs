import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

import { childProcessEnvironment } from 'holo:runtime'

// This profile-bound case uses logical IDs, never Host executable paths.
// The Host supplies cat/echo/sleep and a controlled shell plus HOLO_TEST_ENV.
describe('controlled native process', () => {
  it('runs sync, callback and shell APIs with exact public result delivery', async () => {
    const result = spawnSync('echo', ['sync-ok'], {
      [childProcessEnvironment]: { scope: 'processTree' }
    })
    assert.equal(result.status, 0)
    assert.equal(result.signal, null)
    assert.equal(result.stdout.toString('utf8'), 'sync-ok\n')
    assert.equal(execFileSync('echo', ['file-sync'], { encoding: 'utf8' }), 'file-sync\n')
    assert.equal(execSync('printf shell-sync', { encoding: 'utf8' }), 'shell-sync')
    assert.equal(
      execSync('printf "%s" "$HOLO_TEST_ENV"', {
        encoding: 'utf8',
        env: { HOLO_TEST_ENV: 'explicit-only' }
      }),
      'explicit-only'
    )
    const callback = await new Promise((resolve, reject) => {
      const child = execFile('echo', ['callback-ok'], { encoding: 'utf8' }, function(error, stdout, stderr) {
        if (error) return reject(error)
        try {
          assert.equal(error, null)
          assert.equal(arguments.length, 3)
          assert.equal(stderr, '')
          resolve({ stdout, pid: child.pid })
        } catch (error) {
          reject(error)
        }
      })
      assert(Number.isSafeInteger(child.pid) && child.pid > 0)
    })
    assert.equal(callback.stdout, 'callback-ok\n')
    const shell = await new Promise((resolve, reject) =>
      exec('printf shell-async', { encoding: 'utf8' }, function(error, stdout, stderr) {
        if (error) return reject(error)
        try {
          assert.equal(arguments.length, 3)
          resolve({ stdout, stderr })
        } catch (error) {
          reject(error)
        }
      })
    )
    assert.deepEqual(shell, { stdout: 'shell-async', stderr: '' })
  })

  it('streams binary stdin/stdout with null-exact callbacks and one exit/close', async () => {
    const bytes = Buffer.from([0, 255, 1, 10, 65])
    const output = await new Promise((resolve, reject) => {
      const child = spawn('cat', [])
      const chunks = []
      const counts = { callbacks: 0, close: 0, exit: 0, spawn: 0 }
      child.on('error', reject)
      child.on('spawn', () => counts.spawn++)
      child.stdout.on('data', chunk => chunks.push(chunk))
      child.on('exit', () => counts.exit++)
      child.on('close', (code, signal) => {
        counts.close++
        try {
          assert.equal(code, 0)
          assert.equal(signal, null)
          resolve({ bytes: Buffer.concat(chunks), counts })
        } catch (error) {
          reject(error)
        }
      })
      child.stdout.pause()
      child.stdout.resume()
      const accepted = child.stdin.write(bytes, function(error) {
        try {
          assert.equal(arguments.length, 1)
          assert.equal(error, null)
          counts.callbacks++
        } catch (error) {
          reject(error)
        }
      })
      assert.equal(typeof accepted, 'boolean')
      child.stdin.end(function(error) {
        try {
          assert.equal(arguments.length, 1)
          assert.equal(error, null)
          counts.callbacks++
        } catch (error) {
          reject(error)
        }
      })
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(output.bytes, bytes)
    assert.deepEqual(output.counts, { callbacks: 2, close: 1, exit: 1, spawn: 1 })
  })

  it('delivers bounded failure, timeout, abort and signal results', async () => {
    const failed = await new Promise(resolve =>
      exec('printf failure-stderr >&2; exit 7', { encoding: 'utf8' }, function(error, stdout, stderr) {
        resolve({ error, stdout, stderr, arity: arguments.length })
      })
    )
    assert(failed.error)
    assert.equal(failed.stdout, '')
    assert.equal(failed.stderr, 'failure-stderr')
    assert.equal(failed.arity, 3)
    const timed = spawnSync('sleep', ['2'], { timeout: 25 })
    assert.equal(timed.error?.code, 'ETIMEDOUT')
    assert.equal(timed.status, null)
    const limited = await new Promise(resolve =>
      execFile('echo', ['x'.repeat(1024)], { maxBuffer: 64 }, error => resolve(error))
    )
    assert.equal(limited?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    const controller = new AbortController()
    const aborted = await new Promise(resolve => {
      let failure
      const child = execFile('sleep', ['2'], { signal: controller.signal }, error => failure = error)
      child.once('close', () => resolve(failure))
      controller.abort()
    })
    assert.equal(aborted?.code, 'ABORT_ERR')
    assert.equal(aborted?.name, 'AbortError')
    const signaled = await new Promise((resolve, reject) => {
      const child = spawn('sleep', ['2'])
      child.once('error', reject)
      child.once('spawn', () => child.kill('SIGTERM'))
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    assert.deepEqual(signaled, { code: null, signal: 'SIGTERM' })
    assert.throws(() => spawnSync('not-in-host-profile', []), { code: 'EACCES' })
    assert.throws(() => spawnSync('echo', [], { env: { NOT_GRANTED: 'value' } }), { code: 'EACCES' })
  })
})
