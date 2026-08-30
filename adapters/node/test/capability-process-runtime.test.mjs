import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync as hostExecFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { capabilityRuntimeSession } from './capability-runtime-fixture.mjs'

const entryUrl = 'app+local://workspace/main.mjs'
const moduleRootUrl = 'app+local://workspace/'

const hostProcessList = () => hostExecFileSync('/bin/ps', ['-ax', '-o', 'command='], { encoding: 'utf8' })
const waitForHostProcess = async (token, present) => {
  for (let turn = 0; turn < 200; turn += 1) {
    if (hostProcessList().includes(token) === present) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(hostProcessList().includes(token), present)
}

test('runs the native.darwin-seatbelt-v1 Backend without PATH or native pid exposure', {
  skip: process.platform !== 'darwin'
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-process-m35-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  const processProfile = {
    backend: {
      backendId: 'native.darwin-seatbelt-v1',
      configuration: {
        runtimeReadPaths: ['/opt/homebrew'],
        sandboxExecutablePath: '/usr/bin/sandbox-exec'
      }
    },
    defaultShellExecutableId: 'controlled-shell',
    environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
    executables: [
      {
        executableId: 'controlled-shell',
        executablePath: '/bin/bash',
        fixedArgs: [],
        shell: true
      },
      {
        executableId: 'node-helper',
        executablePath: process.execPath,
        fixedArgs: [],
        shell: false
      }
    ],
    profile: 'process-profile-v1'
  }

  try {
    await supervisor.start(capabilityRuntimeSession({
      entryUrl,
      hostPath: root,
      moduleRootUrl,
      processLimits: {
        maxStdinBytes: 256 * 1024,
        maxStdoutBytes: 1024,
        maxTotalProcesses: 21
      },
      processProfile,
      source: `
      import { childProcessEnvironment } from 'holo:runtime'
      import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process'

      try {
      const sync = spawnSync('node-helper', ['-e', 'process.stdout.write("sync-ok")'], {
        [childProcessEnvironment]: { scope: 'processTree' }
      })
      const syncOutput = execFileSync(
        'node-helper',
        ['-e', 'process.stdout.write("exec-sync-ok")'],
        { encoding: 'utf8' }
      )
      const callback = await new Promise((resolve, reject) => {
        const child = execFile(
          'node-helper',
          ['-e', 'process.stdout.write("callback-ok")'],
          { encoding: 'utf8' },
          function(error, stdout, stderr) {
            if (error) reject(error)
            else resolve({ args: arguments.length, pid: child.pid, stderr, stdout })
          }
        )
      })
      const shell = await new Promise((resolve, reject) => {
        exec('printf shell-callback-ok', { encoding: 'utf8' }, (error, stdout, stderr) => {
          if (error) reject(error)
          else resolve({ stderr, stdout })
        })
      })
      const shellSync = execSync('printf shell-sync-ok', { encoding: 'utf8' })
      const shellSpawn = await new Promise((resolve, reject) => {
        const child = spawn('printf', ['spawn-shell-ok'], { shell: true })
        const chunks = []
        child.stdout.on('data', chunk => chunks.push(...chunk))
        child.on('error', reject)
        child.on('close', code => resolve({ chunks, code }))
      })
      const streamed = await new Promise((resolve, reject) => {
        const child = spawn('node-helper', ['-e', 'process.stdout.write("stream-ok")'])
        const chunks = []
        child.stdout.on('data', chunk => chunks.push(...chunk))
        child.stdout.pause()
        child.stdout.resume()
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ chunks, code, pid: child.pid, signal }))
      })
      const stdin = await new Promise((resolve, reject) => {
        const child = spawn('node-helper', ['-e', 'process.stdin.pipe(process.stdout)'])
        const chunks = []
        child.stdout.on('data', chunk => chunks.push(...chunk))
        child.on('error', reject)
        child.on('close', code => resolve({ chunks, code }))
        child.stdin.write('stdin-ok')
        child.stdin.end()
      })
      const stdinBackpressure = await new Promise((resolve, reject) => {
        const child = spawn('node-helper', ['-e', String.raw\`
          setTimeout(() => process.stdin.resume(), 100)
          process.stdin.on('end', () => process.exit(0))
        \`])
        let callbackArguments
        let callbackError
        let callbackWasAsync = false
        let writing = true
        const accepted = child.stdin.write('x'.repeat(128 * 1024), function(error) {
          callbackArguments = arguments.length
          callbackError = error ?? null
          callbackWasAsync = !writing
        })
        writing = false
        child.stdin.end()
        child.on('error', reject)
        child.on('close', code => resolve({
          accepted,
          callbackArguments,
          callbackError,
          callbackWasAsync,
          code
        }))
      })
      const stdoutBackpressure = await new Promise((resolve, reject) => {
        const child = spawn('node-helper', ['-e', String.raw\`
          process.stdout.write('a')
          setTimeout(() => process.stdout.write('b'), 10)
          setTimeout(() => {}, 100)
        \`])
        const chunks = []
        let chunksWhilePaused
        child.stdout.on('data', chunk => {
          chunks.push(...chunk)
          if (chunks.length === 1) {
            child.stdout.pause()
            setTimeout(() => {
              chunksWhilePaused = chunks.length
              child.stdout.resume()
            }, 40)
          }
        })
        child.on('error', reject)
        child.on('close', code => resolve({ chunks, chunksWhilePaused, code }))
      })
      const pausedOverflow = await new Promise(resolve => {
        const child = spawn('node-helper', ['-e', String.raw\`
          process.stdout.write('a')
          setTimeout(() => process.stdout.write('x'.repeat(2048)), 20)
          setTimeout(() => {}, 100)
        \`])
        const chunks = []
        let errorCode = null
        let streamErrorCode = null
        child.stdout.on('data', chunk => {
          chunks.push(...chunk)
          if (chunks.length === 1) child.stdout.pause()
        })
        child.stdout.on('error', error => { streamErrorCode = error.code })
        child.on('error', error => { errorCode = error.code })
        child.on('close', code => resolve({ chunks, code, errorCode, streamErrorCode }))
      })
      const timedOut = await new Promise(resolve => {
        execFile('node-helper', ['-e', 'setInterval(() => {}, 1000)'], { timeout: 25 }, error => {
          resolve({ code: error?.code, name: error?.name })
        })
      })
      const aborted = await new Promise(resolve => {
        const controller = new AbortController()
        execFile('node-helper', ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal }, error => {
          resolve({ code: error?.code, name: error?.name })
        })
        controller.abort()
      })
      const completedController = new AbortController()
      const completedOutput = await new Promise((resolve, reject) => {
        execFile(
          'node-helper',
          ['-e', 'process.stdout.write("completed-before-abort")'],
          { encoding: 'utf8', signal: completedController.signal },
          (error, stdout) => error ? reject(error) : resolve(stdout)
        )
      })
      let lateAbortError = null
      try { completedController.abort() }
      catch (error) { lateAbortError = error.code ?? error.name }
      const limited = await new Promise(resolve => {
        execFile(
          'node-helper',
          ['-e', 'process.stdout.write("x".repeat(2048))'],
          { maxBuffer: 1024 },
          error => resolve({ code: error?.code, name: error?.name })
        )
      })
      const stdinLimitCode = await new Promise(resolve => {
        const child = spawn('node-helper', ['-e', 'setInterval(() => {}, 1000)'])
        let code = null
        try { child.stdin.write('x'.repeat(256 * 1024 + 1)) }
        catch (error) { code = error.code }
        child.once('close', () => resolve(code))
        child.kill('SIGKILL')
      })
      let syncLimitCode
      try {
        execFileSync(
          'node-helper',
          ['-e', 'process.stdout.write("x".repeat(2048))'],
          { maxBuffer: 1024 }
        )
      }
      catch (error) { syncLimitCode = error.code }
      const signaled = await new Promise(resolve => {
        const child = spawn('node-helper', ['-e', 'setInterval(() => {}, 1000)'])
        child.once('spawn', () => child.kill('SIGTERM'))
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      let unknownCode
      try {
        spawnSync('definitely-not-on-manifest', [])
      } catch (error) {
        unknownCode = error.code
      }
      let environmentCode
      try {
        spawnSync('node-helper', [], {
          [childProcessEnvironment]: { scope: 'runtime' }
        })
      } catch (error) {
        environmentCode = error.code
      }
      let cwdCode
      try { spawnSync('node-helper', [], { cwd: 'holo-fs://workspace/' }) }
      catch (error) { cwdCode = error.code }
      let envCode
      try { spawnSync('node-helper', [], { env: { HOST_SECRET: 'hidden' } }) }
      catch (error) { envCode = error.code }
      let mountCode
      try { spawnSync('node-helper', [], { mounts: [] }) }
      catch (error) { mountCode = error.code }
      let credentialCode
      try { spawnSync('node-helper', [], { credential: 'host-secret' }) }
      catch (error) { credentialCode = error.code }
      const isolation = execFileSync('node-helper', ['-e', String.raw\`
        const fs = require('node:fs')
        const net = require('node:net')
        const cp = require('node:child_process')
        const outcomes = {}
        try { fs.readFileSync('/etc/hosts'); outcomes.filesystem = 'open' }
        catch (error) { outcomes.filesystem = error.code }
        try {
          const nested = cp.spawnSync(process.execPath, ['-e', '0'])
          outcomes.process = nested.error?.code ?? 'open'
        }
        catch (error) { outcomes.process = error.code }
        try { process.kill(process.ppid, 'SIGCONT'); outcomes.signal = 'open' }
        catch (error) { outcomes.signal = error.code }
        const socket = net.connect(80, '127.0.0.1')
        socket.once('connect', () => { outcomes.network = 'open'; done() })
        socket.once('error', error => { outcomes.network = error.code; done() })
        const done = () => process.stdout.write(JSON.stringify(outcomes))
      \`], { encoding: 'utf8' })
      let forkCode
      try { execSync('(exit 0)') }
      catch (error) { forkCode = error.code }
      const finalAllowed = spawnSync('node-helper', ['-e', '0'])
      let totalLimitCode
      try { spawnSync('node-helper', ['-e', '0']) }
      catch (error) { totalLimitCode = error.code }
      console.log('CAPABILITY_PROCESS_M35:' + JSON.stringify({
        callback,
        credentialCode,
        cwdCode,
        envCode,
        environmentCode,
        finalAllowed: { status: finalAllowed.status },
        forkCode,
        isolation: JSON.parse(isolation),
        lateAbort: { error: lateAbortError, stdout: completedOutput },
        shell,
        shellSync,
        aborted,
        limited,
        mountCode,
        pausedOverflow,
        signaled,
        stdin,
        stdinBackpressure,
        stdinLimitCode,
        streamed,
        shellSpawn,
        stdoutBackpressure,
        syncLimitCode,
        timedOut,
        sync: { ...sync, stderr: Array.from(sync.stderr), stdout: Array.from(sync.stdout) },
        syncOutput,
        totalLimitCode,
        unknownCode
      }))
      } catch (error) {
        console.log('CAPABILITY_PROCESS_M35_ERROR:' + JSON.stringify({
          code: error?.code,
          message: error?.message,
          name: error?.name,
          stack: error?.stack
        }))
        throw error
      }
    `
    }))
  } catch (error) {
    t.diagnostic(logs.join('\n'))
    throw error
  }

  const result = JSON.parse(logs.find(value => value.startsWith('CAPABILITY_PROCESS_M35:')).slice(23))
  assert.equal(Buffer.from(result.sync.stdout).toString('utf8'), 'sync-ok')
  assert.equal(result.sync.status, 0)
  assert.equal(result.sync.signal, null)
  assert.equal(result.syncOutput, 'exec-sync-ok')
  assert.equal(result.callback.args, 3)
  assert.equal(result.callback.stdout, 'callback-ok')
  assert.equal(result.callback.stderr, '')
  assert.equal(result.credentialCode, 'ERR_INVALID_ARG_VALUE')
  assert.equal(result.cwdCode, 'EACCES')
  assert.equal(result.envCode, 'EACCES')
  assert.equal(result.environmentCode, 'ERR_INVALID_ARG_VALUE')
  assert.equal(result.finalAllowed.status, 0)
  assert.equal(result.forkCode, 'EIO')
  assert.ok(Number.isSafeInteger(result.callback.pid))
  assert.deepEqual(result.isolation, {
    filesystem: 'EPERM',
    network: 'EPERM',
    process: 'EPERM',
    signal: 'EPERM'
  })
  assert.deepEqual(result.lateAbort, { error: null, stdout: 'completed-before-abort' })
  assert.equal(result.shell.stdout, 'shell-callback-ok')
  assert.equal(result.shell.stderr, '')
  assert.equal(Buffer.from(result.shellSpawn.chunks).toString('utf8'), 'spawn-shell-ok')
  assert.equal(result.shellSpawn.code, 0)
  assert.equal(result.shellSync, 'shell-sync-ok')
  assert.deepEqual(result.aborted, { code: 'ABORT_ERR', name: 'AbortError' })
  assert.deepEqual(result.limited, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', name: 'Error' })
  assert.equal(result.mountCode, 'ERR_INVALID_ARG_VALUE')
  assert.deepEqual(result.pausedOverflow, {
    chunks: [97],
    code: null,
    errorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    streamErrorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  })
  assert.equal(result.signaled.code, null)
  assert.equal(result.signaled.signal, 'SIGTERM')
  assert.equal(Buffer.from(result.stdin.chunks).toString('utf8'), 'stdin-ok')
  assert.equal(result.stdin.code, 0)
  assert.deepEqual(result.stdinBackpressure, {
    accepted: false,
    callbackArguments: 1,
    callbackError: null,
    callbackWasAsync: true,
    code: 0
  })
  assert.equal(result.stdinLimitCode, 'EFBIG')
  assert.equal(Buffer.from(result.streamed.chunks).toString('utf8'), 'stream-ok')
  assert.equal(result.streamed.code, 0)
  assert.equal(result.streamed.signal, null)
  assert.ok(Number.isSafeInteger(result.streamed.pid))
  assert.equal(Buffer.from(result.stdoutBackpressure.chunks).toString('utf8'), 'ab')
  assert.equal(result.stdoutBackpressure.chunksWhilePaused, 1)
  assert.equal(result.stdoutBackpressure.code, 0)
  assert.equal(result.syncLimitCode, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  assert.equal(result.totalLimitCode, 'EMFILE')
  assert.equal(result.unknownCode, 'EACCES')
  assert.deepEqual(result.timedOut, { code: 'ETIMEDOUT', name: 'Error' })
})

test('publishes a stable unsupported Process facade without falling back to ambient child_process', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-process-disabled-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))

  await supervisor.start(capabilityRuntimeSession({
    entryUrl,
    hostPath: root,
    moduleRootUrl,
    source: `
      import { spawnSync } from 'node:child_process'
      let code
      try { spawnSync('node', ['-e', 'process.stdout.write("ambient")']) }
      catch (error) { code = error.code }
      console.log('CAPABILITY_PROCESS_DISABLED:' + JSON.stringify({ code }))
    `
  }))

  const result = JSON.parse(logs.find(value => value.startsWith('CAPABILITY_PROCESS_DISABLED:')).slice(28))
  assert.equal(result.code, 'EACCES')
  assert.equal(logs.some(value => value.includes('ambient')), false)
})

test('restart and stop close every processTree resource from the previous generation', {
  skip: process.platform !== 'darwin'
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-process-restart-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const firstToken = `holonomy-m35-first-${process.pid}-${Date.now()}`
  const secondToken = `holonomy-m35-second-${process.pid}-${Date.now()}`
  const processProfile = {
    backend: {
      backendId: 'native.darwin-seatbelt-v1',
      configuration: {
        runtimeReadPaths: ['/opt/homebrew'],
        sandboxExecutablePath: '/usr/bin/sandbox-exec'
      }
    },
    environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
    executables: [{
      executableId: 'node-helper',
      executablePath: process.execPath,
      fixedArgs: [],
      shell: false
    }],
    profile: 'process-profile-v1'
  }
  const session = token =>
    capabilityRuntimeSession({
      entryUrl,
      hostPath: root,
      moduleRootUrl,
      processProfile,
      source: `
      import { spawn } from 'node:child_process'
      spawn('node-helper', ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(token)}])
      console.log('CAPABILITY_PROCESS_RESTART_READY')
    `
    })

  await supervisor.start(session(firstToken))
  await waitForHostProcess(firstToken, true)
  await supervisor.restart(session(secondToken))
  assert.equal(supervisor.generation, 2)
  await waitForHostProcess(firstToken, false)
  await waitForHostProcess(secondToken, true)
  await supervisor.stop()
  await waitForHostProcess(secondToken, false)
})
