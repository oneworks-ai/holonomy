import assert from 'node:assert/strict'
import { exec, execFile, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { childProcessEnvironment } from 'holo:runtime'

const execute = (executableId, args, input, expectedErrorCode) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${executableId}`)), 90_000)
    let child
    try {
      child = execFile(executableId, args, { encoding: 'utf8' }, function(error, stdout, stderr) {
        clearTimeout(timeout)
        console.log(`V86_CONFORMANCE_EVENT:callback:${executableId}:${arguments.length}:${error?.code ?? 'ok'}`)
        console.log(`V86_CONFORMANCE_EVENT:result:${executableId}:${JSON.stringify({ stderr, stdout })}`)
        if (error) console.log(`V86_CONFORMANCE_EVENT:stderr:${executableId}:${JSON.stringify(stderr)}`)
        if (error && error.code !== expectedErrorCode) reject(error)
        else resolve({ callbackArity: arguments.length, error, stderr, stdout })
      })
    } catch (error) {
      clearTimeout(timeout)
      console.log(`V86_CONFORMANCE_EVENT:spawn-error:${executableId}:${error?.code ?? 'unknown'}`)
      reject(error)
      return
    }
    try {
      if (input != null) child.stdin.write(input)
      child.stdin.end()
    } catch (error) {
      clearTimeout(timeout)
      console.log(`V86_CONFORMANCE_EVENT:stdin-error:${executableId}:${error?.code ?? 'unknown'}`)
      reject(error)
    }
  })

describe('controlled v86 child process', () => {
  it('runs the controlled shell in an isolated processTree environment', async () => {
    let result
    try {
      result = await new Promise((resolve, reject) => {
        exec(
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
    const childResult = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for controlled v86 child process')), 30_000)
      const child = execFile(
        'holo-v86-shell',
        [
          '-c',
          'IFS= read -r value < /workspace/conformance-input.txt; printf "FUSE_INPUT:%s" "$value"; printf GUEST_TO_HOST > /workspace/conformance-output.txt'
        ],
        { encoding: 'utf8' },
        function(error, stdout, stderr) {
          clearTimeout(timeout)
          console.log(`V86_CONFORMANCE_EVENT:callback:${arguments.length}:${error?.code ?? 'ok'}`)
          if (error) reject(error)
          else resolve({ callbackArity: arguments.length, stderr, stdout })
        }
      )
      for (const event of ['spawn', 'error', 'exit', 'close']) {
        child.on(event, (...tuple) => console.log(`V86_CONFORMANCE_EVENT:child:${event}:${tuple.length}`))
      }
      child.stdout.on('data', () => console.log('V86_CONFORMANCE_EVENT:stdout:data'))
      child.stdout.on('end', () => console.log('V86_CONFORMANCE_EVENT:stdout:end'))
      child.stdout.on('close', () => console.log('V86_CONFORMANCE_EVENT:stdout:close'))
      child.stderr.on('data', () => console.log('V86_CONFORMANCE_EVENT:stderr:data'))
      child.stderr.on('end', () => console.log('V86_CONFORMANCE_EVENT:stderr:end'))
      child.stderr.on('close', () => console.log('V86_CONFORMANCE_EVENT:stderr:close'))
      assert.equal(typeof child.on, 'function')
      assert.ok(child.stdout)
      assert.ok(child.stderr)
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
      'holo-v86-timeout',
      ['5', '/usr/bin/nc', '-u', '-w', '2', 'android-v86.test', '18089'],
      'android-guest-datagram',
      'ERR_OPERATION_FAILED'
    )

    assert.equal(tcp.callbackArity, 3)
    assert.equal(tcp.stderr, '')
    assert.equal(tcp.stdout, 'HOLO_ANDROID_V86_TCP_OK')
    assert.equal(udp.callbackArity, 3)
    assert.equal(udp.error?.code, 'ERR_OPERATION_FAILED')
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

  it('re-admits registered descendants and denies unresolved targets', async () => {
    console.log('V86_CONFORMANCE_EVENT:case:descendant:start')
    const result = await execute('holo-v86-shell', [
      '-c',
      [
        '/bin/cat /dev/null && printf DESCENDANT_ALLOWED',
        'PATH=/bin:/usr/bin cat /dev/null && printf PATH_LOOKUP_ALLOWED',
        'if /usr/bin/jq --version >/dev/null 2>&1; then exit 91; else printf DESCENDANT_DENIED; fi',
        'cd /bin',
        'if ./cat /dev/null 2>/dev/null; then exit 92; else printf RELATIVE_EXEC_DENIED; fi'
      ].join('; ')
    ])

    assert.equal(
      result.stdout,
      'DESCENDANT_ALLOWEDPATH_LOOKUP_ALLOWEDDESCENDANT_DENIEDRELATIVE_EXEC_DENIED'
    )
    console.log('V86_CONFORMANCE_EVENT:descendant:allow-deny:ok')
  })

  it('enforces timeout, AbortSignal and readable flow control through the public facade', async () => {
    const timeoutResult = await new Promise(resolve => {
      const child = spawn('holo-v86-shell', ['-c', 'while :; do :; done'], { timeout: 50 })
      let errorCode
      child.on('error', error => {
        errorCode = error.code
      })
      child.on('close', (code, signal) => resolve({ code, errorCode, signal }))
    })
    assert.deepEqual(timeoutResult, { code: null, errorCode: 'ETIMEDOUT', signal: 'SIGKILL' })

    const controller = new AbortController()
    const abortResult = await new Promise(resolve => {
      const child = execFile(
        'holo-v86-shell',
        ['-c', 'while :; do :; done'],
        { encoding: 'utf8', signal: controller.signal },
        function(error, stdout, stderr) {
          resolve({ arity: arguments.length, errorCode: error?.code, stderr, stdout })
        }
      )
      child.on('spawn', () => controller.abort())
    })
    assert.deepEqual(abortResult, { arity: 3, errorCode: 'ABORT_ERR', stderr: '', stdout: '' })

    const flowResult = await new Promise((resolve, reject) => {
      const child = spawn('holo-v86-shell', [
        '-c',
        'sleep 0.15; printf FIRST; sleep 0.15; printf SECOND'
      ])
      let output = ''
      let outputWhilePaused
      child.stdout.on('data', chunk => {
        output += new TextDecoder().decode(chunk)
      })
      child.on('error', reject)
      child.stdout.pause()
      setTimeout(() => {
        outputWhilePaused = output
        child.stdout.resume()
      }, 225)
      child.on('close', (code, signal) => resolve({ code, output, outputWhilePaused, signal }))
    })
    assert.deepEqual(flowResult, {
      code: 0,
      output: 'FIRSTSECOND',
      outputWhilePaused: '',
      signal: null
    })
    console.log('V86_CONFORMANCE_EVENT:process-control:timeout-abort-flow:ok')
  })
})
