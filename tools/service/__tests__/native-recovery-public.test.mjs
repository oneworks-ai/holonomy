import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'

import { waitForOperation } from '../../holonomy-managed-command.mjs'
import { prepareHolonomyRuntimePlugins } from '../../holonomy-plugin-bundle.mjs'
import { startHolonomyPluginWatch } from '../../holonomy-plugin-watch.mjs'
import { createNativeRuntimeAdapter } from '../native-target-adapter.mjs'
import { createHolonomyService } from '../server.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'
import { nativeInflightBounded } from './native-inflight-http-fixture.mjs'
import { nativeLogContains } from './native-log-text.mjs'

const executable = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const token = 'native-recovery-public-token-at-least-32-bytes'
const generations = 6
const revisionsPerGeneration = 4
const entryUrl = 'app://workspace/index.mjs'
const policy = {
  device: { defaultAccess: 'deny', maxEventsPerSecond: 1, maxQueuedEvents: 0, maxSubscriptions: 0, operations: {} },
  filesystem: { access: 'none' },
  schemaVersion: 2,
  systemInformation: {
    defaultMode: 'unavailable',
    fields: { 'os.arch': { allowedModes: ['synthetic'], maxPrecision: 'exact' } }
  }
}

const until = async (read, accepts, label, durationMs = 8_000) => {
  const deadline = Date.now() + durationMs
  let last
  do {
    last = await read()
    if (accepts(last)) return last
    await new Promise(resolve => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  assert.fail(`${label}: ${JSON.stringify(last)}`)
}

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const fdCount = pid => {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim().split('\n').length - 1
}

const config = (mode, sequence) => ({
  plugins: [{ config: { mode, sequence }, id: 'recovery', use: './plugin-package' }]
})

const input = bundles => ({
  capabilityRuntime: {
    context: {
      guest: { application: { id: 'native.recovery.public', name: 'Native Recovery' } },
      host: { tenantId: 'isolated-recovery-fixture' },
      schemaVersion: 1
    },
    initialMiddlewareId: 'service.continue.v1',
    sandboxPolicy: policy,
    schemaVersion: 1
  },
  deviceId: 'native:local',
  entryUrl,
  inspectorMode: 'off',
  isolation: 'runtime',
  launch: {
    argv: [entryUrl],
    command: 'run',
    entryUrl,
    moduleRootUrl: 'app://workspace/',
    modules: [{
      source: [
        "import assert from 'node:assert/strict'",
        "import os from 'node:os'",
        "console.log('RECOVERY_START')",
        'setInterval(() => {',
        '  try {',
        '    const value = os.arch()',
        "    assert.equal(typeof value, 'string')",
        '    assert.ok(value.length > 0)',
        "    console.log('RECOVERY_ALLOW')",
        '  } catch (error) {',
        "    assert.equal(error.code, 'ERR_ACCESS_DENIED')",
        "    console.log('RECOVERY_DENY')",
        '  }',
        '}, 30)'
      ].join('\n'),
      url: entryUrl
    }],
    reporter: 'tap',
    schemaVersion: 2,
    target: 'native'
  },
  runtimePlugins: bundles,
  target: 'native'
})

it.skipIf(executable == null || process.platform !== 'darwin')(
  'keeps last good plugin state and generation fences through 24 watched revisions and Native recovery',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-native-recovery-')))
    const home = join(root, 'home')
    const configPath = join(root, 'holo.config.json')
    const stateDirectory = join(home, 'state')
    const children = []
    const childCloses = new Map()
    const diagnostics = []
    const measurements = []
    let watch
    let service
    let processId
    let generation = 1
    let revision = 1
    let cursor = 0
    let mode = 'allow'
    let client
    let reservation
    let primaryFailure
    let hasPrimaryFailure = false
    const cleanupFailures = []
    const attemptCleanup = async (label, action) => {
      try {
        await nativeInflightBounded(Promise.resolve().then(action), label)
      } catch (error) {
        cleanupFailures.push(error)
        process.stderr.write(`NATIVE_RECOVERY_CLEANUP_FAILURE ${label}: ${String(error).slice(0, 300)}\n`)
      }
    }
    const writeConfig = async (nextMode, sequence) => writeFile(configPath, JSON.stringify(config(nextMode, sequence)))
    const bundles = () => prepareHolonomyRuntimePlugins(configPath).bundles
    const operation = async admitted =>
      until(
        () => client.getOperation(admitted.value.operation.id),
        value => ['succeeded', 'failed', 'cancelled'].includes(value.state),
        'Service operation'
      )
    const observe = async (marker, currentGeneration = generation) => {
      const page = await until(
        () => client.readLogs(processId, { after: cursor, limit: 256 }),
        value => nativeLogContains(value, marker, currentGeneration),
        `${marker} in generation ${currentGeneration}`
      )
      assert(page.events.every(event => event.generation <= currentGeneration), 'future log crossed cursor')
      cursor = page.cursor
    }
    const childFor = async currentGeneration =>
      until(
        async () => children[currentGeneration - 1],
        value => Number.isSafeInteger(value?.pid),
        `owned child for generation ${currentGeneration}`
      )
    try {
      await mkdir(home, { mode: 0o700 })
      const pluginRoot = join(root, 'plugin-package')
      await mkdir(pluginRoot)
      await writeFile(
        join(pluginRoot, 'index.mjs'),
        [
          'export default (ctx, config) => {',
          "  ctx.holo.intercept({operation:'system.os.arch.read'},",
          "    (invocation, next) => config.mode === 'deny' ? ctx.holo.deny(invocation) : next(),",
          "    {execution:'sync'})",
          '}'
        ].join('\n')
      )
      await writeFile(
        join(pluginRoot, 'package.json'),
        JSON.stringify({
          holo: { apiVersion: 1, configSchema: './schema.json', entry: './index.mjs', kind: 'runtime-plugin' },
          type: 'module'
        })
      )
      await writeFile(
        join(pluginRoot, 'schema.json'),
        JSON.stringify({
          additionalProperties: false,
          properties: { mode: { enum: ['allow', 'deny'] }, sequence: { type: 'integer' } },
          required: ['mode', 'sequence'],
          type: 'object'
        })
      )
      await writeConfig(mode, 0)
      const adapter = createNativeRuntimeAdapter({
        executablePath: executable,
        stateDirectory,
        spawn(file, args, options) {
          const child = spawn(file, args, { ...options, env: { ...options.env, HOLONOMY_HOME: home, PATH: '' } })
          childCloses.set(
            child,
            new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
          )
          children.push(child)
          return child
        }
      })
      service = createHolonomyService({ nativeAdapter: adapter, port: 0, stateDirectory, token })
      await service.start()
      client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
      await client.call('/v1/devices:refresh', { body: {}, method: 'POST' })
      const started = await client.launchProcess(input(bundles()), randomUUID())
      processId = started.value.process.id
      assert.equal((await operation(started)).state, 'succeeded')
      await observe('RECOVERY_START')
      await observe('RECOVERY_ALLOW')

      for (generation = 1; generation <= generations; generation += 1) {
        const current = await client.getProcess(processId)
        assert.equal(current.generation, generation)
        assert.equal(current.pluginGraphRevision, revision)
        assert.equal(current.state, 'running')
        const owned = await childFor(generation)
        assert.equal(alive(owned.pid), true)
        measurements.push({ generation, pid: owned.pid, openDescriptors: fdCount(owned.pid) })
        watch = startHolonomyPluginWatch({
          client,
          configPath,
          dependencies: { waitForOperation },
          io: { stderr: { write: text => diagnostics.push(text) } },
          pluginRoots: [],
          process: current,
          runtimePlugins: bundles()
        })

        for (let step = 1; step <= revisionsPerGeneration; step += 1) {
          const nextMode = mode === 'allow' ? 'deny' : 'allow'
          const sequence = (generation - 1) * revisionsPerGeneration + step
          const concurrentReads = Promise.all([
            client.getProcess(processId),
            client.readLogs(processId, { after: cursor })
          ])
          await writeConfig(nextMode, sequence)
          const [seenProcess, seenLogs] = await concurrentReads
          assert.equal(seenProcess.generation, generation)
          assert(seenLogs.events.every(event => event.generation === generation))
          const updated = await until(
            () => client.getProcess(processId),
            value => value.pluginGraphRevision === revision + 1,
            `watched revision ${sequence}`
          )
          revision += 1
          assert.equal(updated.generation, generation)
          assert.equal(updated.state, 'running')
          await observe(nextMode === 'allow' ? 'RECOVERY_ALLOW' : 'RECOVERY_DENY')
          mode = nextMode

          if (step === 2) {
            const rejectedBefore = diagnostics.filter(text => text.includes('candidate was rejected')).length
            await writeConfig(mode, 'invalid-schema')
            await until(
              async () => diagnostics.filter(text => text.includes('candidate was rejected')).length,
              count => count > rejectedBefore,
              `rejected watch candidate in generation ${generation}`
            )
            assert.equal((await client.getProcess(processId)).pluginGraphRevision, revision)
            await observe(mode === 'allow' ? 'RECOVERY_ALLOW' : 'RECOVERY_DENY')
            await writeConfig(mode, sequence)
          }
        }
        await watch.close()
        watch = undefined
        if (generation === generations) break
        const previousPid = owned.pid
        if (generation === 3) {
          const stopped = await client.processAction(processId, 'stop', generation, randomUUID())
          assert.equal((await operation(stopped)).state, 'succeeded')
          await until(async () => alive(previousPid), value => value === false, 'explicitly stopped Native child')
          assert.equal((await client.getProcess(processId)).state, 'cancelled')
        }
        const restarted = await client.processAction(processId, 'restart', generation, randomUUID())
        assert.equal((await operation(restarted)).state, 'succeeded')
        const fresh = await client.getProcess(processId)
        assert.equal(fresh.generation, generation + 1)
        assert.equal(fresh.pluginGraphRevision, revision)
        await until(async () => alive(previousPid), value => value === false, 'retired Native child')
        await nativeInflightBounded(childCloses.get(owned), 'retired Native child close')
        await assert.rejects(client.processAction(processId, 'stop', generation, randomUUID()))
        await assert.rejects(client.replaceRuntimePlugins(
          processId,
          { expectedGeneration: generation, runtimePlugins: bundles() },
          revision,
          randomUUID()
        ))
        await observe('RECOVERY_START', generation + 1)
        await observe(mode === 'allow' ? 'RECOVERY_ALLOW' : 'RECOVERY_DENY', generation + 1)
      }

      const victim = await childFor(generations)
      assert.equal(alive(victim.pid), true)
      const concurrentReadsAtExit = Promise.all([
        client.getProcess(processId),
        client.readLogs(processId, { after: cursor, limit: 256, waitMs: 250 })
      ])
      victim.kill('SIGKILL')
      const [seenProcessAtExit, seenLogsAtExit] = await concurrentReadsAtExit
      assert.equal(seenProcessAtExit.generation, generations)
      assert(seenLogsAtExit.events.every(event => event.generation === generations))
      const failed = await until(
        () => client.getProcess(processId),
        value => value.state === 'failed',
        'unexpected Native exit'
      )
      assert.equal(failed.generation, generations)
      await until(async () => alive(victim.pid), value => value === false, 'unexpected child reaped')
      assert.equal((await nativeInflightBounded(childCloses.get(victim), 'unexpected child close')).signal, 'SIGKILL')
      const recovery = await client.processAction(processId, 'restart', generations, randomUUID())
      assert.equal((await operation(recovery)).state, 'succeeded')
      assert.equal((await client.getProcess(processId)).generation, generations + 1)
      assert.equal((await client.getProcess(processId)).pluginGraphRevision, revision)
      await assert.rejects(client.processAction(processId, 'stop', generations, randomUUID()))
      await observe('RECOVERY_START', generations + 1)
      await observe(mode === 'allow' ? 'RECOVERY_ALLOW' : 'RECOVERY_DENY', generations + 1)
      const recovered = await childFor(generations + 1)
      measurements.push({ generation: generations + 1, pid: recovered.pid, openDescriptors: fdCount(recovered.pid) })
      assert.equal(new Set(measurements.map(row => row.pid)).size, generations + 1)
      const stopped = await client.processAction(processId, 'stop', generations + 1, randomUUID())
      assert.equal((await operation(stopped)).state, 'succeeded')
      await until(async () => alive(recovered.pid), value => value === false, 'final Native child reaped')
      await nativeInflightBounded(childCloses.get(recovered), 'final Native child close')
      const retained = []
      let after = 0
      while (true) {
        const page = await client.readLogs(processId, { after, limit: 256 })
        if (page.events.length === 0) break
        assert(page.cursor > after)
        retained.push(...page.events)
        after = page.cursor
      }
      let latestGeneration = 1
      for (const event of retained) {
        assert(event.generation >= latestGeneration, 'a retired generation published after its successor')
        latestGeneration = event.generation
      }
      assert.equal(latestGeneration, generations + 1)
      for (let index = 1; index <= generations + 1; index += 1) {
        const output = retained.filter(event => event.generation === index && event.stream === 'stdout')
          .map(event => event.chunk).join('')
        assert.equal(output.match(/RECOVERY_START/gu)?.length, 1, `generation ${index} entry count`)
      }
      await client.removeProcess(processId, generations + 1, randomUUID())
      await assert.rejects(stat(join(stateDirectory, 'native-processes', processId)), error => error.code === 'ENOENT')
      assert.equal((await client.call('/v1/processes')).some(row => row.id === processId), false)
      const servicePort = Number(new URL(service.baseUrl).port)
      await nativeInflightBounded(service.close(), 'Service close')
      assert.equal(service.server.listening, false)
      service = undefined
      reservation = createServer()
      await new Promise((resolve, reject) => {
        reservation.once('error', reject)
        reservation.listen(servicePort, '127.0.0.1', resolve)
      })
      await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
      reservation = undefined
      process.stdout.write(
        `NATIVE_RECOVERY_EVIDENCE ${JSON.stringify({ revisions: revision, measurements, servicePortRebound: true })}\n`
      )
    } catch (error) {
      primaryFailure = error
      hasPrimaryFailure = true
    } finally {
      await attemptCleanup('plugin watch', async () => watch?.close())
      await attemptCleanup('Service', async () => {
        if (service == null) return
        await service.close()
        assert.equal(service.server.listening, false)
      })
      await attemptCleanup('port reservation', async () => {
        if (reservation?.listening) {
          await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
        }
      })
      for (const child of children) {
        await attemptCleanup(`owned child ${child.pid}`, async () => {
          if (!Number.isSafeInteger(child.pid)) return
          if (child.exitCode == null && child.signalCode == null && alive(child.pid)) child.kill('SIGKILL')
          await until(
            async () => child.exitCode != null || child.signalCode != null,
            value => value === true,
            `owned child ${child.pid} terminal`
          )
          await nativeInflightBounded(childCloses.get(child), `owned child ${child.pid} actual close`)
        })
      }
      if (cleanupFailures.length === 0) {
        await attemptCleanup('fixture root', async () => rm(root, { force: true, recursive: true }))
      } else {
        process.stderr.write(`NATIVE_RECOVERY_FIXTURE_RETAINED ${root}\n`)
      }
    }
    if (hasPrimaryFailure) throw primaryFailure
    if (cleanupFailures.length > 0) throw cleanupFailures[0]
  },
  60_000
)
