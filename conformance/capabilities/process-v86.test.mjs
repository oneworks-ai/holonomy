import assert from 'node:assert/strict'
import { exec, execFile, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { childProcessEnvironment } from 'holo:runtime'

import { watchV86Child } from './process-v86-watchdog.mjs'

const execute = (executableId, args, input, expectedErrorCode) =>
  watchV86Child(executableId, ({ resolve, reject }) => {
    let child
    try {
      child = execFile(executableId, args, { encoding: 'utf8' }, function(error, stdout, stderr) {
        console.log(`V86_CONFORMANCE_EVENT:callback:${executableId}:${arguments.length}:${error?.code ?? 'ok'}`)
        console.log(`V86_CONFORMANCE_EVENT:result:${executableId}:${JSON.stringify({ stderr, stdout })}`)
        if (error) console.log(`V86_CONFORMANCE_EVENT:stderr:${executableId}:${JSON.stringify(stderr)}`)
        const acceptedError = expectedErrorCode === 'nonzero-exit'
          ? Number.isInteger(error?.code) && error.code > 0
          : error?.code === expectedErrorCode
        if (error && !acceptedError) reject(error)
        else resolve({ callbackArity: arguments.length, error, stderr, stdout })
      })
    } catch (error) {
      console.log(`V86_CONFORMANCE_EVENT:spawn-error:${executableId}:${error?.code ?? 'unknown'}`)
      reject(error)
      return
    }
    try {
      if (input != null) child.stdin.write(input)
      child.stdin.end()
    } catch (error) {
      console.log(`V86_CONFORMANCE_EVENT:stdin-error:${executableId}:${error?.code ?? 'unknown'}`)
      reject(error)
    }
    return child
  })

describe('controlled v86 child process', () => {
  it('runs the controlled shell in an isolated processTree environment', async () => {
    let result
    try {
      result = await watchV86Child('controlled processTree shell', ({ resolve, reject }) => {
        return exec(
          'printf PROCESS_TREE_SHELL_OK',
          {
            [childProcessEnvironment]: { scope: 'processTree' },
            encoding: 'utf8'
          },
          function(error, stdout, stderr) {
            if (error) reject(error)
            else resolve({ arity: arguments.length, stderr, stdout })
          }
        )
      })
    } catch (error) {
      console.log(`V86_CONFORMANCE_EVENT:scope:error:${error?.code ?? 'unknown'}:${error?.message ?? error}`)
      throw error
    }
    assert.deepEqual(result, { arity: 3, stderr: '', stdout: 'PROCESS_TREE_SHELL_OK' })
    console.log('V86_CONFORMANCE_EVENT:scope:process-tree-shell:ok')
  })

  it('executes a Linux program through the public Node facade and bridged filesystem', async () => {
    console.log('V86_CONFORMANCE_EVENT:case:filesystem:start')
    writeFileSync('holo-fs://workspace/conformance-input.txt', 'holonomy-guest-input', 'utf8')
    const childResult = await watchV86Child('controlled v86 child process', ({ resolve, reject, on }) => {
      const child = execFile(
        'holo-v86-shell',
        [
          '-c',
          'IFS= read -r value < /workspace/conformance-input.txt; printf "FUSE_INPUT:%s" "$value"; printf GUEST_TO_HOST > /workspace/conformance-output.txt'
        ],
        { encoding: 'utf8' },
        function(error, stdout, stderr) {
          console.log(`V86_CONFORMANCE_EVENT:callback:${arguments.length}:${error?.code ?? 'ok'}`)
          console.log(`V86_CONFORMANCE_EVENT:filesystem-result:${
            JSON.stringify({
              error: error == null ? null : { code: error.code, message: error.message },
              stderr,
              stdout
            })
          }`)
          if (error) reject(error)
          else resolve({ callbackArity: arguments.length, stderr, stdout })
        }
      )
      for (const event of ['spawn', 'error', 'exit', 'close']) {
        on(child, event, (...tuple) => console.log(`V86_CONFORMANCE_EVENT:child:${event}:${tuple.length}`))
      }
      on(child.stdout, 'data', () => console.log('V86_CONFORMANCE_EVENT:stdout:data'))
      on(child.stdout, 'end', () => console.log('V86_CONFORMANCE_EVENT:stdout:end'))
      on(child.stdout, 'close', () => console.log('V86_CONFORMANCE_EVENT:stdout:close'))
      on(child.stderr, 'data', () => console.log('V86_CONFORMANCE_EVENT:stderr:data'))
      on(child.stderr, 'end', () => console.log('V86_CONFORMANCE_EVENT:stderr:end'))
      on(child.stderr, 'close', () => console.log('V86_CONFORMANCE_EVENT:stderr:close'))
      assert.equal(typeof child.on, 'function')
      assert.ok(child.stdout)
      assert.ok(child.stderr)
      return child
    })

    assert.equal(childResult.callbackArity, 3)
    assert.equal(childResult.stdout, 'FUSE_INPUT:holonomy-guest-input')
    assert.equal(childResult.stderr, '')
    assert.equal(readFileSync('holo-fs://workspace/conformance-output.txt', 'utf8'), 'GUEST_TO_HOST')
    console.log('V86_CONFORMANCE_EVENT:case:filesystem:end')
  })

  it('bridges Linux TCP and UDP through Process Network authority', async () => {
    console.log('V86_CONFORMANCE_EVENT:case:network:start')
    const tcp = await execute('holo-v86-curl', [
      '--fail',
      '--silent',
      '--show-error',
      '--noproxy',
      '*',
      'http://android-v86.test:18088/v86'
    ])
    const udp = await execute(
      'holo-v86-nc',
      ['-u', '-w', '2', 'android-v86.test', '18089'],
      'android-guest-datagram',
      'nonzero-exit'
    )

    assert.equal(tcp.callbackArity, 3)
    assert.equal(tcp.stderr, '')
    assert.equal(tcp.stdout, 'HOLO_ANDROID_V86_TCP_OK')
    assert.equal(udp.callbackArity, 3)
    assert.ok(udp.error == null || Number.isInteger(udp.error.code) && udp.error.code > 0)
    assert.equal(udp.stderr, '')
    assert.equal(udp.stdout, 'HOLO_ANDROID_V86_UDP_OK:android-guest-datagram')
    console.log('V86_CONFORMANCE_EVENT:network:tcp-udp:ok')
  })

  it('projects Host device and system authority into Linux', async () => {
    console.log('V86_CONFORMANCE_EVENT:case:capability:start')
    const device = await execute('holo-v86-hoholo', ['device', 'summary'])
    const system = await execute('holo-v86-hoholo', ['system', 'read', 'os.arch'])
    const summary = JSON.parse(device.stdout)

    assert.equal(device.stderr, '')
    assert.equal(summary.schemaVersion, 1)
    assert.equal(summary.formFactor.status, 'available')
    assert.ok(['phone', 'tablet'].includes(summary.formFactor.value))
    assert.equal(system.stderr, '')
    assert.ok(['arm64', 'x64'].includes(JSON.parse(system.stdout)))
    console.log('V86_CONFORMANCE_EVENT:capability:device-system:ok')
  })

  it('denies Guest-internal exec regardless of its path form', async () => {
    console.log('V86_CONFORMANCE_EVENT:case:descendant:start')
    for (
      const command of [
        'exec /bin/cat /dev/null',
        'PATH=/bin:/usr/bin; exec cat /dev/null',
        'cd /bin; exec ./cat /dev/null'
      ]
    ) {
      const result = await execute('holo-v86-shell', ['-c', command], undefined, 'nonzero-exit')
      assert.ok(Number.isInteger(result.error?.code) && result.error.code > 0)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /Operation not permitted/u)
    }
    console.log('V86_CONFORMANCE_EVENT:descendant:denied:ok')
  })

  it('enforces timeout, AbortSignal and readable flow control through the public facade', async () => {
    const timeoutResult = await watchV86Child('50ms execution timeout', ({ resolve, on }) => {
      const child = spawn('holo-v86-shell', ['-c', 'while :; do :; done'], { timeout: 50 })
      let errorCode
      on(child, 'error', error => {
        errorCode = error.code
      })
      on(child, 'close', (code, signal) => resolve({ code, errorCode, signal }))
      return child
    })
    assert.deepEqual(timeoutResult, { code: null, errorCode: 'ETIMEDOUT', signal: 'SIGKILL' })

    const controller = new AbortController()
    const abortResult = await watchV86Child('AbortSignal cancellation', ({ resolve, on }) => {
      const child = execFile(
        'holo-v86-shell',
        ['-c', 'while :; do :; done'],
        { encoding: 'utf8', signal: controller.signal },
        function(error, stdout, stderr) {
          resolve({ arity: arguments.length, errorCode: error?.code, stderr, stdout })
        }
      )
      on(child, 'spawn', () => controller.abort())
      return child
    })
    assert.deepEqual(abortResult, { arity: 3, errorCode: 'ABORT_ERR', stderr: '', stdout: '' })

    const flowResult = await watchV86Child('controlled v86 readable flow', ({ resolve, reject, on, setTimeout }) => {
      const child = spawn('holo-v86-shell', [
        '-c',
        'printf FIRST; IFS= read -r line; printf SECOND; IFS= read -r line'
      ])
      let output = ''
      let outputWhilePaused
      let paused = false
      let released = false
      let pauseTimer
      on(child.stdout, 'data', chunk => {
        output += new TextDecoder().decode(chunk)
        if (!paused && output === 'FIRST') {
          paused = true
          child.stdout.pause()
          child.stdin.write('continue\n')
          pauseTimer = setTimeout(() => {
            outputWhilePaused = output
            child.stdout.resume()
          }, 225)
        } else if (!released && output === 'FIRSTSECOND') {
          released = true
          child.stdin.write('finish\n')
          child.stdin.end()
        }
      })
      on(child, 'error', error => {
        clearTimeout(pauseTimer)
        reject(error)
      })
      on(child, 'close', (code, signal) => {
        clearTimeout(pauseTimer)
        resolve({ code, output, outputWhilePaused, signal })
      })
      return child
    })
    assert.deepEqual(flowResult, {
      code: 0,
      output: 'FIRSTSECOND',
      outputWhilePaused: 'FIRST',
      signal: null
    })
    console.log('V86_CONFORMANCE_EVENT:process-control:timeout-abort-flow:ok')
  })
})
