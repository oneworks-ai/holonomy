import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { prepareHolonomyRuntimePlugins } from '../../holonomy-plugin-bundle.mjs'
import { createNativeRuntimeAdapter } from '../native-target-adapter.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const entryUrl = 'app://workspace/entry.mjs'
const processRecord = id => ({
  entryUrl,
  generation: 1,
  id,
  launch: {
    argv: [entryUrl],
    command: 'run',
    entryUrl,
    moduleRootUrl: 'app://workspace/',
    modules: [{ source: 'console.log("ready")', url: entryUrl }],
    schemaVersion: 2,
    target: 'native'
  },
  target: 'native'
})

const assertStageRemoved = async (stateDirectory, id) => {
  await assert.rejects(
    stat(join(stateDirectory, 'native-processes', id, 'g1')),
    error => error.code === 'ENOENT'
  )
}

describe('native private launch failure cleanup', () => {
  it.skipIf(binary == null)('uses a short owner-private Inspector socket and cleans only its generation', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holonomy-native-inspector-state-with-a-long-name-'))
    const process = { ...processRecord('process_inspector_private'), inspectorMode: 'break' }
    let privateLaunch
    const adapter = createNativeRuntimeAdapter({
      executablePath: binary,
      stateDirectory,
      spawn() {
        const child = new EventEmitter()
        child.pid = 1_234_580
        child.stdin = new PassThrough()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()]
        child.stdin.on('data', bytes => privateLaunch = JSON.parse(bytes.toString('utf8')))
        child.stdin.once('finish', () => {
          child.stdout.end()
          child.stderr.end()
          child.stdio[3].end()
          child.emit('close', 0, null)
        })
        child.kill = () => true
        queueMicrotask(() => child.emit('spawn'))
        return child
      }
    })
    try {
      assert.deepEqual(await adapter.startProcess({ process }), { waitingForDebugger: true })
      assert.equal(privateLaunch.inspectorWaitForDebugger, true)
      assert.ok(Buffer.byteLength(privateLaunch.inspectorSocket) <= 100)
      assert.ok(!privateLaunch.inspectorSocket.startsWith(stateDirectory))
      const socketDirectory = dirname(privateLaunch.inspectorSocket)
      const marker = JSON.parse(
        await readFile(
          join(stateDirectory, 'native-processes', process.id, 'g1', 'host', 'inspector-owner.json'),
          'utf8'
        )
      )
      assert.equal(marker.directory, socketDirectory)
      assert.equal(marker.processId, process.id)
      assert.equal(marker.generation, process.generation)
      assert.equal((await stat(socketDirectory)).mode & 0o777, 0o700)
      await adapter.stopProcess({ process })
      await assert.rejects(stat(socketDirectory), error => error.code === 'ENOENT')
    } finally {
      await adapter.close()
      await rm(stateDirectory, { force: true, recursive: true })
    }
  })

  it.skipIf(binary == null)('kills an unacknowledged plugin candidate before reporting failure', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holonomy-native-ack-timeout-'))
    const fixture = await mkdtemp(join(tmpdir(), 'holonomy-native-ack-plugin-'))
    await writeFile(join(fixture, 'plugin.mjs'), 'export default () => undefined')
    await writeFile(
      join(fixture, 'holo.config.json'),
      JSON.stringify({
        plugins: [{ id: 'late', use: './plugin.mjs' }]
      })
    )
    const candidate = prepareHolonomyRuntimePlugins(join(fixture, 'holo.config.json')).bundles
    let child
    const adapter = createNativeRuntimeAdapter({
      executablePath: binary,
      stateDirectory,
      spawn() {
        child = new EventEmitter()
        child.pid = 1_234_570
        child.stdin = new PassThrough()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()]
        child.kill = () => true
        child.stdin.once('finish', () => {
          child.stdout.end()
          child.stderr.end()
          child.stdio[3].end()
          child.emit('close', 0, null)
        })
        queueMicrotask(() => {
          child.emit('spawn')
          child.stdio[3].write('{"event":"ready","revision":0,"applied":true}\n')
        })
        return child
      }
    })
    try {
      const process = processRecord('process_ack_timeout')
      await adapter.startProcess({ process })
      let terminal
      await adapter.subscribeProcess({
        process,
        onTerminal: event => {
          terminal = event
        }
      })
      await assert.rejects(
        adapter.applyRuntimePlugins({
          expectedRevision: 0,
          process,
          revision: 1,
          runtimePlugins: candidate
        }),
        error => error.code === 'service.unavailable'
      )
      assert.equal(child.stdin.writableEnded, true)
      assert.equal(terminal?.state, 'failed')
      child.stdio[3].emit('data', Buffer.from('{"event":"update","revision":1,"applied":true}\n'))
      const config = JSON.parse(
        await readFile(join(stateDirectory, 'native-processes', process.id, 'g1', 'host', 'host.json'), 'utf8')
      )
      assert.deepEqual(config.plugins, [])
    } finally {
      await adapter.close()
      await rm(stateDirectory, { force: true, recursive: true })
      await rm(fixture, { force: true, recursive: true })
    }
  }, 10_000)

  it.skipIf(binary == null)('bounds a noncooperative child stop and retains cleanup-pending evidence', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holo-native-stop-bound-'))
    let forced = 0
    const adapter = createNativeRuntimeAdapter({
      executablePath: binary,
      stateDirectory,
      spawn() {
        const child = new EventEmitter()
        child.pid = 1_234_569
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new Writable({
          write(_chunk, _encoding, done) {
            done()
          }
        })
        child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()]
        child.kill = () => {
          forced++
          return false
        }
        queueMicrotask(() => {
          child.emit('spawn')
          child.stdio[3].write('{"event":"ready","revision":0,"applied":true}\n')
        })
        return child
      }
    })
    try {
      const process = processRecord('process_stop_bound')
      await adapter.startProcess({ process })
      vi.useFakeTimers()
      const stopped = expect(adapter.stopProcess({ process })).rejects.toMatchObject({
        code: 'service.unavailable',
        details: { cleanupPending: true }
      })
      await vi.advanceTimersByTimeAsync(3001)
      await stopped
      assert.equal(forced, 1)
      assert.equal((await stat(join(stateDirectory, 'native-processes', process.id, 'g1'))).isDirectory(), true)
    } finally {
      vi.useRealTimers()
      await adapter.close()
      await rm(stateDirectory, { force: true, recursive: true })
    }
  })

  it.skipIf(binary == null)('sends one bounded private launch and retains stdin until stop', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holonomy-native-launch-line-'))
    let child
    let payload = ''
    const adapter = createNativeRuntimeAdapter({
      executablePath: binary,
      stateDirectory,
      spawn() {
        child = new EventEmitter()
        child.pid = 1_234_568
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new Writable({
          write(chunk, _encoding, callback) {
            payload += chunk.toString('utf8')
            callback()
          }
        })
        child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()]
        child.stdin.once('finish', () => {
          child.stdout.end()
          child.stderr.end()
          child.emit('close', 0, null)
        })
        child.kill = () => true
        queueMicrotask(() => {
          child.emit('spawn')
          child.stdio[3].write('{"event":"ready","revision":0,"applied":true}\n')
        })
        return child
      }
    })
    try {
      const process = processRecord('process_launch_line')
      await adapter.startProcess({ process })
      assert.equal(child.stdin.writableEnded, false)
      assert.equal(payload.endsWith('\n'), true)
      const privateLaunch = JSON.parse(payload)
      assert.deepEqual(privateLaunch.moduleAllowlist, [entryUrl])
      assert.equal(privateLaunch.schemaVersion, 2)
      assert(privateLaunch.entry.startsWith(`${privateLaunch.workspaceRoot}/`))
      assert.equal(privateLaunch.generation, 1)
      assert.equal(privateLaunch.testMode, false)
      assert.equal(privateLaunch.hostConfig.schemaVersion, 1)
      await adapter.stopProcess({ process })
      assert.equal(child.stdin.writableEnded, true)
    } finally {
      await adapter.close()
      await rm(stateDirectory, { force: true, recursive: true })
    }
  })

  it('retains a pending generation when this adapter cannot prove ownership', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holonomy-native-pending-'))
    const generationRoot = join(stateDirectory, 'native-processes', 'process_pending', 'g1')
    const hostRoot = join(generationRoot, 'host')
    await mkdir(hostRoot, { recursive: true })
    await writeFile(
      join(hostRoot, 'child.json'),
      JSON.stringify({
        generation: 1,
        pid: process.pid,
        processId: 'process_pending'
      }),
      { mode: 0o600 }
    )
    const adapter = createNativeRuntimeAdapter({ executablePath: '/not-used', stateDirectory })
    try {
      assert.deepEqual(
        await adapter.reconcileProcess({ process: { generation: 1, id: 'process_pending' } }),
        { cleaned: false }
      )
      await assert.rejects(
        adapter.removeProcess({ process: { cleanupPending: true, generation: 1, id: 'process_pending' } }),
        error => error.code === 'service.conflict'
      )
      assert.equal((await stat(generationRoot)).isDirectory(), true)
    } finally {
      await adapter.close()
      await rm(stateDirectory, { force: true, recursive: true })
    }
  })

  it.skipIf(binary == null)('closes an early EPIPE child and removes its staged generation', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holonomy-native-epipe-'))
    const calls = []
    const adapter = createNativeRuntimeAdapter({
      executablePath: binary,
      stateDirectory,
      spawn(file, args, options) {
        calls.push({ args, file, options })
        const child = new EventEmitter()
        child.pid = 1_234_567
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new Writable({
          write(_chunk, _encoding, callback) {
            callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
          }
        })
        child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()]
        child.kill = () => {
          queueMicrotask(() => {
            child.stdout.end()
            child.stderr.end()
            child.emit('close', null, 'SIGKILL')
          })
          return true
        }
        queueMicrotask(() => child.emit('spawn'))
        return child
      }
    })
    try {
      await assert.rejects(
        adapter.startProcess({ process: processRecord('process_epipe') }),
        error => error.code === 'service.unavailable'
      )
      assert.deepEqual(calls[0].args, ['__runtime'])
      assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe', 'pipe'])
      assert.deepEqual(calls[0].options.env, { PATH: '' })
      await assertStageRemoved(stateDirectory, 'process_epipe')
    } finally {
      await adapter.close()
      await rm(stateDirectory, { force: true, recursive: true })
    }
  })

  it.skipIf(binary == null)('removes staging after a synchronous spawn failure', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holonomy-native-spawn-'))
    const adapter = createNativeRuntimeAdapter({
      executablePath: binary,
      stateDirectory,
      spawn() {
        throw new Error('spawn failed')
      }
    })
    try {
      await assert.rejects(
        adapter.startProcess({ process: processRecord('process_spawn') }),
        error => error.code === 'service.unavailable'
      )
      await assertStageRemoved(stateDirectory, 'process_spawn')
    } finally {
      await adapter.close()
      await rm(stateDirectory, { force: true, recursive: true })
    }
  })

  it.skipIf(binary == null)('removes staging after an asynchronous spawn error', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holonomy-native-spawn-event-'))
    const adapter = createNativeRuntimeAdapter({
      executablePath: binary,
      stateDirectory,
      spawn() {
        const child = new EventEmitter()
        child.stdin = new PassThrough()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()]
        child.kill = () => true
        queueMicrotask(() => {
          child.emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' }))
          child.stdin.end()
          child.stdout.end()
          child.stderr.end()
          child.emit('close', -2, null)
        })
        return child
      }
    })
    try {
      await assert.rejects(
        adapter.startProcess({ process: processRecord('process_spawn_event') }),
        error => error.code === 'service.unavailable'
      )
      await assertStageRemoved(stateDirectory, 'process_spawn_event')
    } finally {
      await adapter.close()
      await rm(stateDirectory, { force: true, recursive: true })
    }
  })
})
