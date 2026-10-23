import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { it } from 'node:test'

// These assertions run inside the real Native holo Guest. The outer Node
// driver supplies only local endpoints, private installation, and effect counts.
export const registerNativeProcessNetworkLifecycleTests = fixture => {
  const watch = (child, marker, trackAbort = false) => {
    let stdout = ''
    let stderr = ''
    let errorCode
    let errorName
    let errorCount = 0
    const order = []
    let readyResolve
    let readyReject
    let readySeen = false
    let closed = false
    const ready = marker == null ? Promise.resolve() : new Promise((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    child.stdout.on('data', bytes => {
      stdout += new TextDecoder().decode(bytes)
      if (!readySeen && stdout.includes(marker)) {
        readySeen = true
        readyResolve?.()
      }
    })
    child.stderr.on('data', bytes => stderr += new TextDecoder().decode(bytes))
    const done = new Promise(resolve => {
      child.on('error', error => {
        errorCode = error.code
        if (trackAbort) {
          errorName = error.name
          errorCount++
          order.push('error')
        }
      })
      child.once('close', (code, signal) => {
        closed = true
        if (trackAbort) order.push('close')
        if (marker != null && !readySeen) readyReject(new Error(`Missing ${marker}: ${stderr}`))
        resolve({
          code,
          errorCode,
          signal,
          stderr,
          stdout,
          ...(trackAbort ? { abort: { errorCount, errorName, order: [...order] } } : {})
        })
      })
    })
    return {
      ready,
      done,
      get closed() {
        return closed
      },
      get order() {
        return [...order]
      }
    }
  }

  const netcat = (input, signal) => {
    const child = spawn('nc', ['-w', '8', fixture.address, String(fixture.tcpPort)], {
      signal,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const result = watch(child, input.startsWith('HOLD_') ? 'TCP_READY' : null, signal != null)
    child.stdin.write(input)
    if (!input.startsWith('HOLD_')) child.stdin.end()
    return {
      child,
      ready: result.ready,
      done: result.done,
      get closed() {
        return result.closed
      }
    }
  }

  const curl = (path, signal) => {
    const child = spawn('curl', [
      '--silent',
      '--show-error',
      '--fail',
      '--no-buffer',
      '--max-time',
      '8',
      '--noproxy',
      '',
      '--proxy',
      'http://192.168.86.1:80',
      `http://${fixture.address}:${fixture.httpPort}/${path}`
    ], { signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = watch(child, path.startsWith('hold-') ? 'HTTP_READY' : null, signal != null)
    return {
      child,
      ready: result.ready,
      done: result.done,
      get closed() {
        return result.closed
      }
    }
  }

  it('aborts a connected Linux TCP process and reuses the one socket in the same Runtime', async () => {
    assert.equal(process.versions.node, undefined)
    const controller = new AbortController()
    const held = netcat('HOLD_ABORT', controller.signal)
    try {
      await held.ready
      // The Host accepted the real TCP connection and sent TCP_READY.
      // AbortSignal termination must release that flow before the next spawn.
      controller.abort()
      const result = await held.done
      assert.equal(result.errorCode, 'ABORT_ERR', JSON.stringify(result))
      assert.equal(result.signal, 'SIGTERM')
      assert.equal(result.stdout, 'TCP_READY')
      assert.deepEqual(result.abort, { errorCount: 1, errorName: 'AbortError', order: ['error', 'close'] })
    } finally {
      if (!held.closed) {
        try {
          held.child.kill('SIGKILL')
        } catch {}
      }
      await held.done
    }
    const after = netcat('AFTER_ABORT')
    assert.deepEqual(await after.done, {
      code: 0,
      errorCode: undefined,
      signal: null,
      stderr: '',
      stdout: 'TCP_AFTER'
    })
  })

  it('aborts a connected Linux HTTP process and reuses the one socket in the same Runtime', async () => {
    const controller = new AbortController()
    const held = curl('hold-abort', controller.signal)
    try {
      await held.ready
      controller.abort()
      const result = await held.done
      assert.equal(result.errorCode, 'ABORT_ERR', JSON.stringify(result))
      assert.equal(result.signal, 'SIGTERM')
      assert.equal(result.stdout, 'HTTP_READY')
      assert.deepEqual(result.abort, { errorCount: 1, errorName: 'AbortError', order: ['error', 'close'] })
    } finally {
      if (!held.closed) {
        try {
          held.child.kill('SIGKILL')
        } catch {}
      }
      await held.done
    }
    const after = curl('after-abort')
    assert.deepEqual(await after.done, {
      code: 0,
      errorCode: undefined,
      signal: null,
      stderr: '',
      stdout: 'HTTP_AFTER'
    })
  })

  it('closes a connected Linux HTTP process and reuses the one socket in the same Runtime', async () => {
    const held = curl('hold-kill')
    try {
      await held.ready
      assert.equal(held.child.kill('SIGKILL'), true)
      const result = await held.done
      assert.equal(result.code, null)
      assert.equal(result.signal, 'SIGKILL')
      assert.equal(result.stdout, 'HTTP_READY')
    } finally {
      if (!held.closed) held.child.kill('SIGKILL')
      await held.done
    }
    const after = curl('after-kill')
    assert.deepEqual(await after.done, {
      code: 0,
      errorCode: undefined,
      signal: null,
      stderr: '',
      stdout: 'HTTP_AFTER'
    })
  })

  it('rejects a second network flow at maxSockets=1 without a Host connection', async () => {
    const held = netcat('HOLD_QUOTA')
    try {
      await held.ready
      const denied = netcat('QUOTA_PROBE')
      const result = await denied.done
      assert.deepEqual(result, {
        code: 0,
        errorCode: undefined,
        signal: null,
        stderr: '',
        stdout: ''
      })
      assert.equal(held.closed, false, JSON.stringify({ denied: result, heldClosed: held.closed }))
      assert.equal(held.child.kill('SIGKILL'), true)
      const first = await held.done
      assert.equal(first.signal, 'SIGKILL')
    } finally {
      if (!held.closed) {
        try {
          held.child.kill('SIGKILL')
        } catch {}
      }
      await held.done
    }
    const after = netcat('AFTER_QUOTA')
    assert.deepEqual(await after.done, {
      code: 0,
      errorCode: undefined,
      signal: null,
      stderr: '',
      stdout: 'TCP_AFTER'
    })
  })

  it('delivers a pre-aborted spawn error after listener setup without a Host TCP connection', async () => {
    assert.equal(process.versions.node, undefined)
    const controller = new AbortController()
    controller.abort()
    const child = spawn('nc', ['-w', '8', fixture.address, String(fixture.tcpPort)], {
      signal: controller.signal,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const observed = watch(child, null, true)
    assert.deepEqual(observed.order, [])
    try {
      await new Promise(resolve => process.nextTick(resolve))
      assert.equal(observed.order[0], 'error')
      const result = await observed.done
      assert.equal(result.code, null)
      assert.equal(result.errorCode, 'ABORT_ERR')
      assert.equal(result.signal, 'SIGTERM')
      assert.equal(result.stdout, '')
      assert.deepEqual(result.abort, { errorCount: 1, errorName: 'AbortError', order: ['error', 'close'] })
    } finally {
      if (!observed.closed) {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
      await observed.done
    }
    const after = netcat('AFTER_PRE_ABORT')
    assert.deepEqual(await after.done, {
      code: 0,
      errorCode: undefined,
      signal: null,
      stderr: '',
      stdout: 'TCP_AFTER'
    })
  })
}

export const registerNativeProcessNetworkNewRuntimeTest = fixture => {
  it('receives only its own HTTP result after a previous Runtime ended with a pending response', async () => {
    assert.equal(process.versions.node, undefined)
    const child = spawn('curl', [
      '--silent',
      '--show-error',
      '--fail',
      '--no-buffer',
      '--max-time',
      '8',
      '--noproxy',
      '',
      '--proxy',
      'http://192.168.86.1:80',
      `http://${fixture.address}:${fixture.httpPort}/new-runtime`
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let errorCode
    child.stdout.on('data', bytes => stdout += new TextDecoder().decode(bytes))
    child.stderr.on('data', bytes => stderr += new TextDecoder().decode(bytes))
    child.on('error', error => errorCode = error.code)
    const [code, signal] = await new Promise(resolve => child.once('close', (...values) => resolve(values)))
    assert.deepEqual({ code, errorCode, signal, stderr, stdout }, {
      code: 0,
      errorCode: undefined,
      signal: null,
      stderr: '',
      stdout: 'NEW_RUNTIME'
    })
  })
}
