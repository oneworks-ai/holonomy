/* eslint-disable max-lines -- real Native Service lifecycle and plugin graph acceptance share one executable fixture. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

import { normalizeRuntimePluginBundlesV1, runtimePluginBundleDigestV1 } from '../../../src/runtime/plugin-bundle.ts'
import { parseHolonomyArgs } from '../../holonomy-cli-options.mjs'
import { runHolonomyRuntimeCommand } from '../../holonomy-managed-command.mjs'
import { prepareHolonomyRuntimePlugins } from '../../holonomy-plugin-bundle.mjs'
import { createHolonomyServiceLifecycleManager } from '../lifecycle-manager.mjs'
import { readServiceNativeRuntimeInstallation } from '../native-runtime-installation.mjs'
import { createHolonomyService } from '../server.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const token = 'native-test-token-that-is-at-least-thirty-two-bytes'
const entryUrl = 'app://workspace/run.mjs'
const mainUrl = 'app://workspace/main.mjs'
const childServiceEntry = fileURLToPath(new URL('./native-service-child.mjs', import.meta.url))

const runningPid = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const waitFor = async (read, predicate, label) => {
  for (let turn = 0; turn < 500; turn += 1) {
    const value = await read()
    if (predicate(value)) return value
    if (value?.state === 'failed' || value?.state === 'cancelled') {
      assert.fail(`${label} ended ${value.state}: ${JSON.stringify(value.error)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`${label} did not settle`)
}

const launch = (source, options = {}) => ({
  capabilityRuntime: {
    context: {
      guest: { application: { id: 'native.service.test', name: 'Native Service' } },
      host: { tenantId: 'private-native-test' },
      schemaVersion: 1
    },
    initialMiddlewareId: 'service.continue.v1',
    sandboxPolicy: { schemaVersion: 2 },
    schemaVersion: 1
  },
  deviceId: 'native:local',
  entryUrl,
  inspectorMode: 'off',
  isolation: 'runtime',
  launch: {
    argv: [entryUrl, 'hello'],
    command: options.command ?? 'run',
    entryUrl,
    moduleRootUrl: 'app://workspace/',
    modules: [
      { source: `import ${JSON.stringify(mainUrl)}\n`, url: entryUrl },
      { source, url: mainUrl }
    ],
    reporter: options.reporter ?? 'tap',
    schemaVersion: 2,
    target: 'native'
  },
  target: 'native'
})

describe('service HTTP to embedded Native Runtime', () => {
  it.skipIf(binary == null)('runs read-only and Host-gated Native Inspector leases through a real child', async () => {
    const home = await mkdtemp(join(tmpdir(), 'holonomy-native-inspector-service-'))
    const service = createHolonomyService({
      nativeExecutablePath: binary,
      port: 0,
      stateDirectory: join(home, 'a-very-long-state-directory-name', 'state'),
      token
    })
    const allowedExpression = '21 * 2'
    const allowedHash = createHash('sha256').update(allowedExpression).digest('hex')
    const plugin =
      `export default c => { c.holo.engineGate(r => r.entryDetail?.source === 'inspector' && r.sourceSha256 === '${allowedHash}' ? {action:'allow'} : {action:'deny',reasonCode:'host.inspector_denied'}) }`
    await writeFile(join(home, 'gate.mjs'), plugin)
    await writeFile(join(home, 'holo.config.json'), JSON.stringify({ plugins: [{ id: 'gate', use: './gate.mjs' }] }))
    try {
      await service.start()
      const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
      await client.call('/v1/devices:refresh', { body: {}, method: 'POST' })

      const readOnly = launch("console.log('NATIVE_READ_ONLY'); setInterval(() => {}, 1000)")
      readOnly.inspectorMode = 'enabled'
      const readStarted = await client.launchProcess(readOnly, 'native-read-only-start')
      const readId = readStarted.value.process.id
      await waitFor(
        () => client.getOperation(readStarted.value.operation.id),
        value => value.state === 'succeeded',
        'read-only start'
      )
      const readOpened = await client.openInspector(readId, 1, 'native-read-only-open')
      await waitFor(
        () => client.getOperation(readOpened.value.operation.id),
        value => value.state === 'succeeded',
        'read-only Inspector'
      )
      const readLease = service.core.inspectorProxy().connect(readOpened.value.inspector.id, () => undefined)
      assert.equal(typeof (await readLease.receive({ id: 1, method: 'Runtime.getIsolateId' })).result.id, 'string')
      assert.equal(
        (await readLease.receive({ id: 2, method: 'Runtime.evaluate', params: { expression: '1+1' } })).error.code,
        -32_000
      )
      const readStopped = await client.processAction(readId, 'stop', 1, 'native-read-only-stop')
      await waitFor(
        () => client.getOperation(readStopped.value.operation.id),
        value => value.state === 'succeeded',
        'read-only stop'
      )
      await client.removeProcess(readId, 1, 'native-read-only-remove')

      const controlled = launch("console.log('NATIVE_BREAK_ENTRY'); setInterval(() => {}, 1000)")
      controlled.inspectorMode = 'break'
      controlled.capabilityRuntime.sandboxPolicy = {
        codeGeneration: {
          dynamicImport: { access: 'none' },
          strings: { access: 'controlled', decisionTimeoutMs: 1000, maxOperations: 8, maxSourceBytes: 4096 },
          wasm: { access: 'none' }
        },
        inspector: { evaluate: true },
        schemaVersion: 2
      }
      controlled.runtimePlugins = prepareHolonomyRuntimePlugins(join(home, 'holo.config.json')).bundles
      const started = await client.launchProcess(controlled, 'native-inspector-break-start')
      const id = started.value.process.id
      await waitFor(
        () => client.getOperation(started.value.operation.id),
        value => value.state === 'succeeded',
        'break start'
      )
      assert.equal((await client.getProcess(id)).state, 'waiting_for_debugger')
      assert.equal((await client.readLogs(id)).events.some(event => event.chunk.includes('NATIVE_BREAK_ENTRY')), false)
      const firstOpened = await client.openInspector(id, 1, 'native-inspector-first')
      await waitFor(
        () => client.getOperation(firstOpened.value.operation.id),
        value => value.state === 'succeeded',
        'first Inspector'
      )
      const secondOpened = await client.openInspector(id, 1, 'native-inspector-second')
      await waitFor(
        () => client.getOperation(secondOpened.value.operation.id),
        value => value.state === 'succeeded',
        'second Inspector'
      )
      const proxy = service.core.inspectorProxy()
      const firstInspector = service.core.get('inspectors', firstOpened.value.inspector.id, 'Inspector lease')
      const badToken = 'not-the-lease-token'
      assert.throws(
        () => proxy.connectAuthorized(firstInspector.id, badToken, () => undefined),
        error => error.code === 'service.unauthorized'
      )
      const first = proxy.connect(firstInspector.id, () => undefined)
      const second = proxy.connect(secondOpened.value.inspector.id, () => undefined)
      const [one, two] = await Promise.all([
        first.receive({ id: 9, method: 'Runtime.getIsolateId' }),
        second.receive({ id: 9, method: 'Runtime.getIsolateId' })
      ])
      assert.equal(typeof one.result.id, 'string')
      assert.equal(two.result.id, one.result.id)
      assert.equal(
        (await first.receive({ id: 10, method: 'Runtime.evaluate', params: { expression: 'globalThis.escape=true' } }))
          .error.code,
        -32_000
      )
      assert.equal(
        (await second.receive({
          id: 10,
          method: 'Runtime.evaluate',
          params: { expression: allowedExpression, returnByValue: true }
        })).error.code,
        -32_000
      )
      await client.closeInspector(id, firstInspector.id, 1, 'native-inspector-first-close')
      assert.equal((await first.receive({ id: 11, method: 'Runtime.enable' })).error.code, -32_000)
      assert.ok((await second.receive({ id: 11, method: 'Runtime.enable' })).result != null)
      assert.ok((await second.receive({ id: 12, method: 'Runtime.runIfWaitingForDebugger' })).result != null)
      await waitFor(() => client.getProcess(id), value => value.state === 'running', 'break resume')
      await waitFor(
        () => client.readLogs(id),
        page => page.events.some(event => event.chunk.includes('NATIVE_BREAK_ENTRY')),
        'post-resume entry'
      )
      assert.equal(
        (await second.receive({
          id: 14,
          method: 'Runtime.evaluate',
          params: { expression: allowedExpression, returnByValue: true }
        })).result.result.value,
        42
      )
      assert.equal(
        (await second.receive({ id: 15, method: 'Runtime.evaluate', params: { expression: 'globalThis.escape=true' } }))
          .error.code,
        -32_000
      )

      const restarted = await client.processAction(id, 'restart', 1, 'native-inspector-restart')
      await waitFor(
        () => client.getOperation(restarted.value.operation.id),
        value => value.state === 'succeeded',
        'Inspector restart'
      )
      assert.equal((await client.getProcess(id)).generation, 2)
      assert.equal((await client.getProcess(id)).state, 'waiting_for_debugger')
      assert.equal((await second.receive({ id: 13, method: 'Runtime.enable' })).error.code, -32_000)
      const stopped = await client.processAction(id, 'stop', 2, 'native-inspector-stop-waiting')
      await waitFor(
        () => client.getOperation(stopped.value.operation.id),
        value => value.state === 'succeeded',
        'waiting stop'
      )
      await client.removeProcess(id, 2, 'native-inspector-remove')
    } finally {
      await service.close()
      await rm(home, { force: true, recursive: true })
    }
  }, 40_000)

  it.skipIf(binary == null)('applies Native plugin bundle diffs with revision and generation fencing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'holonomy-native-plugins-'))
    const service = createHolonomyService({
      nativeExecutablePath: binary,
      port: 0,
      stateDirectory: join(home, 'state'),
      token
    })
    const configPath = join(home, 'holo.config.json')
    const source = `export default (ctx, config) => {
      ctx.holo.intercept({operation:'system.os.arch.read'},
        (invocation,next) => config.deny ? ctx.holo.deny(invocation) : next(),
        {execution:'sync'});
    }`
    await writeFile(join(home, 'allow.mjs'), source)
    await writeFile(join(home, 'second.mjs'), source)
    await writeFile(join(home, 'broken.mjs'), "export default () => { throw new Error('broken plugin') }")
    const schemaRoot = join(home, 'schema-plugin')
    await mkdir(schemaRoot)
    await writeFile(join(schemaRoot, 'index.mjs'), source)
    await writeFile(
      join(schemaRoot, 'schema.json'),
      JSON.stringify({
        additionalProperties: false,
        properties: { revision: { type: 'integer' } },
        required: ['revision'],
        type: 'object'
      })
    )
    await writeFile(
      join(schemaRoot, 'package.json'),
      JSON.stringify({
        holo: { apiVersion: 1, configSchema: './schema.json', entry: './index.mjs', kind: 'runtime-plugin' }
      })
    )
    const bundles = async plugins => {
      await writeFile(configPath, JSON.stringify({ plugins }))
      return prepareHolonomyRuntimePlugins(configPath).bundles
    }
    const allow = { config: { deny: false }, id: 'allow', use: './allow.mjs' }
    const second = deny => ({ config: { deny }, id: 'second', use: './second.mjs' })
    const initial = await bundles([allow])
    const policy = {
      device: { defaultAccess: 'deny', maxEventsPerSecond: 1, maxQueuedEvents: 0, maxSubscriptions: 0, operations: {} },
      filesystem: { access: 'none' },
      schemaVersion: 2,
      systemInformation: {
        defaultMode: 'unavailable',
        fields: {
          'os.arch': { allowedModes: ['synthetic'], maxPrecision: 'exact' }
        }
      }
    }
    try {
      await service.start()
      const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
      await client.call('/v1/devices:refresh', { body: {}, method: 'POST' })
      const input = launch(`import os from 'node:os'; setInterval(() => {
        try { console.log('PLUGIN_VALUE:' + os.arch()) }
        catch (error) { console.log('PLUGIN_DENY:' + error.code) }
      }, 30)`)
      input.capabilityRuntime.sandboxPolicy = policy
      input.runtimePlugins = initial
      const started = await client.launchProcess(input, 'native-plugin-start')
      const id = started.value.process.id
      await waitFor(
        () => client.getOperation(started.value.operation.id),
        operation => operation.state === 'succeeded',
        'plugin start'
      )
      let cursor = 0
      const observe = async marker => {
        const page = await waitFor(
          () => client.readLogs(id, { after: cursor, limit: 256 }),
          value => value.events.some(event => event.chunk.includes(marker)),
          marker
        )
        cursor = page.cursor
      }
      await observe('PLUGIN_VALUE:')
      const replace = async (candidate, expectedRevision, key) => {
        const admitted = await client.replaceRuntimePlugins(
          id,
          { expectedGeneration: 1, runtimePlugins: candidate },
          expectedRevision,
          key
        )
        try {
          return await waitFor(
            () => client.getOperation(admitted.value.operation.id),
            operation => operation.state === 'succeeded',
            key
          )
        } catch (error) {
          const logs = await client.readLogs(id, { after: 0, limit: 512 })
          assert.fail(`${error.message}; logs=${JSON.stringify(logs.events)}`)
        }
      }
      const withSecond = await bundles([allow, second(true)])
      assert.equal((await replace(withSecond, 1, 'native-plugin-add')).result.process.pluginGraphRevision, 2)
      await observe('PLUGIN_DENY:')
      const updated = await bundles([allow, second(false)])
      assert.equal((await replace(updated, 2, 'native-plugin-update')).result.process.pluginGraphRevision, 3)
      await observe('PLUGIN_VALUE:')
      const broken = await bundles([allow, { id: 'broken', use: './broken.mjs' }])
      const rejected = await client.replaceRuntimePlugins(
        id,
        { expectedGeneration: 1, runtimePlugins: broken },
        3,
        'native-plugin-host-reject'
      )
      await waitFor(
        () => client.getOperation(rejected.value.operation.id),
        operation => operation.state === 'failed',
        'Host plugin rejection'
      )
      assert.equal((await client.getProcess(id)).pluginGraphRevision, 3)
      await observe('PLUGIN_VALUE:')
      const malformed = [{ ...updated[0], bundleSha256: '0'.repeat(64) }]
      await assert.rejects(
        client.replaceRuntimePlugins(
          id,
          { expectedGeneration: 1, runtimePlugins: malformed },
          3,
          'native-plugin-invalid'
        )
      )
      assert.equal((await client.getProcess(id)).pluginGraphRevision, 3)
      await assert.rejects(
        client.replaceRuntimePlugins(id, { expectedGeneration: 1, runtimePlugins: initial }, 1, 'native-plugin-stale')
      )
      const duplicate = await client.replaceRuntimePlugins(
        id,
        { expectedGeneration: 1, runtimePlugins: updated },
        3,
        'native-plugin-duplicate'
      )
      await waitFor(
        () => client.getOperation(duplicate.value.operation.id),
        operation => operation.state === 'failed',
        'duplicate graph rejection'
      )
      assert.equal((await client.getProcess(id)).pluginGraphRevision, 3)
      const withSchema = await bundles([allow, {
        config: { revision: 1 },
        id: 'schema',
        use: './schema-plugin'
      }])
      normalizeRuntimePluginBundlesV1(withSchema)
      assert.equal((await replace(withSchema, 3, 'native-plugin-schema-valid')).result.process.pluginGraphRevision, 4)
      const invalidSchema = withSchema.map(bundle =>
        bundle.instanceId !== 'schema' ? bundle : {
          ...bundle,
          bundleSha256: runtimePluginBundleDigestV1({ ...bundle, config: { revision: 'bad' } }),
          config: { revision: 'bad' }
        }
      )
      const invalid = await client.replaceRuntimePlugins(
        id,
        { expectedGeneration: 1, runtimePlugins: invalidSchema },
        4,
        'native-plugin-invalid-schema'
      )
      await waitFor(
        () => client.getOperation(invalid.value.operation.id),
        operation => operation.state === 'failed',
        'Native schema rejection'
      )
      await waitFor(
        () => client.readLogs(id, { after: 0, limit: 512 }),
        page => page.events.some(event => event.chunk.includes('schema validation failed')),
        'Native schema validator evidence'
      )
      assert.equal((await client.getProcess(id)).pluginGraphRevision, 4)
      await observe('PLUGIN_VALUE:')
      assert.equal((await replace(initial, 4, 'native-plugin-remove')).result.process.pluginGraphRevision, 5)
      await observe('PLUGIN_VALUE:')
      const stopped = await client.processAction(id, 'stop', 1, 'native-plugin-stop')
      await waitFor(
        () => client.getOperation(stopped.value.operation.id),
        operation => operation.state === 'succeeded',
        'plugin stop'
      )
      const restarted = await client.processAction(id, 'restart', 1, 'native-plugin-restart')
      try {
        await waitFor(
          () => client.getOperation(restarted.value.operation.id),
          operation => operation.state === 'succeeded',
          'plugin restart'
        )
      } catch (error) {
        const logs = await client.readLogs(id, { after: 0, limit: 512 })
        assert.fail(`${error.message}; logs=${JSON.stringify(logs.events)}`)
      }
      const current = await client.getProcess(id)
      assert.equal(current.generation, 2)
      assert.equal(current.pluginGraphRevision, 5)
      await assert.rejects(
        client.replaceRuntimePlugins(
          id,
          { expectedGeneration: 1, runtimePlugins: [] },
          5,
          'native-plugin-old-generation'
        )
      )
      const terminal = await client.processAction(id, 'stop', 2, 'native-plugin-terminal')
      await waitFor(
        () => client.getOperation(terminal.value.operation.id),
        operation => operation.state === 'succeeded',
        'plugin terminal'
      )
      await assert.rejects(
        client.replaceRuntimePlugins(
          id,
          { expectedGeneration: 2, runtimePlugins: [] },
          5,
          'native-plugin-after-terminal'
        )
      )
      await client.removeProcess(id, 2, 'native-plugin-remove-process')

      const bare = launch(`import os from 'node:os'; setInterval(() => {
        try { console.log('BARE_VALUE:' + os.arch()) }
        catch (error) { console.log('BARE_DENY:' + error.code) }
      }, 30)`)
      bare.capabilityRuntime.sandboxPolicy = policy
      const bareStart = await client.launchProcess(bare, 'native-bare-start')
      const bareId = bareStart.value.process.id
      await waitFor(
        () => client.getOperation(bareStart.value.operation.id),
        operation => operation.state === 'succeeded',
        'bare Native start'
      )
      const added = await client.replaceRuntimePlugins(
        bareId,
        { expectedGeneration: 1, runtimePlugins: [withSecond[1]] },
        0,
        'native-bare-add'
      )
      const addedOperation = await waitFor(
        () => client.getOperation(added.value.operation.id),
        operation => operation.state === 'succeeded',
        'bare Native plugin add'
      )
      assert.equal(addedOperation.result.process.pluginGraphRevision, 1)
      await waitFor(
        () => client.readLogs(bareId, { after: 0, limit: 256 }),
        page => page.events.some(event => event.chunk.includes('BARE_DENY:ERR_ACCESS_DENIED')),
        'bare Native plugin effect'
      )
      const bareStop = await client.processAction(bareId, 'stop', 1, 'native-bare-stop')
      await waitFor(
        () => client.getOperation(bareStop.value.operation.id),
        operation => operation.state === 'succeeded',
        'bare Native stop'
      )
      await client.removeProcess(bareId, 1, 'native-bare-remove')
    } finally {
      await service.close()
      await rm(home, { force: true, recursive: true })
    }
  }, 30_000)

  it.skipIf(binary == null)('retains logs and owns stop, restart, generation fencing and removal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'holonomy-native-service-'))
    const service = createHolonomyService({
      nativeExecutablePath: binary,
      port: 0,
      stateDirectory: join(home, 'state'),
      token
    })
    try {
      await service.start()
      const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
      const devices = await client.call('/v1/devices:refresh', { body: {}, method: 'POST' })
      assert.ok(devices.some(device => device.id === 'native:local' && device.state === 'online'))

      const started = await client.launchProcess(
        launch("console.log('NATIVE_HTTP_OK', process.argv[2]); setInterval(() => {}, 1000)"),
        'native-start'
      )
      const id = started.value.process.id
      await waitFor(
        () => client.getOperation(started.value.operation.id),
        operation => operation.state === 'succeeded',
        'start'
      )
      const first = await waitFor(
        () => client.readLogs(id, { after: 0, limit: 100 }),
        page => page.events.some(event => event.chunk.includes('NATIVE_HTTP_OK hello')),
        'Native Guest output'
      )
      assert.ok(first.events.some(event => event.generation === 1))
      const hostFile = join(home, 'state', 'native-processes', id, 'g1', 'host', 'host.json')
      assert.equal((await stat(hostFile)).mode & 0o077, 0)
      assert.equal((await readFile(hostFile, 'utf8')).includes('executablePath'), false)
      assert.equal(JSON.parse(await readFile(hostFile, 'utf8')).context.host.tenantId, 'private-native-test')

      const stopped = await client.processAction(id, 'stop', 1, 'native-stop')
      await waitFor(
        () => client.getOperation(stopped.value.operation.id),
        operation => operation.state === 'succeeded',
        'stop'
      )
      const restarted = await client.processAction(id, 'restart', 1, 'native-restart')
      await waitFor(
        () => client.getOperation(restarted.value.operation.id),
        operation => operation.state === 'succeeded',
        'restart'
      )
      const current = await client.getProcess(id)
      assert.equal(current.generation, 2)
      assert.equal(current.state, 'running')
      await waitFor(
        () => client.readLogs(id, { after: first.cursor, limit: 100 }),
        page => page.events.some(event => event.generation === 2 && event.chunk.includes('NATIVE_HTTP_OK hello')),
        'second generation output'
      )
      const stopAgain = await client.processAction(id, 'stop', 2, 'native-stop-2')
      await waitFor(
        () => client.getOperation(stopAgain.value.operation.id),
        operation => operation.state === 'succeeded',
        'second stop'
      )
      await client.removeProcess(id, 2, 'native-remove')
      await assert.rejects(stat(join(home, 'state', 'native-processes', id)), error => error.code === 'ENOENT')
    } finally {
      await service.close()
      await rm(home, { force: true, recursive: true })
    }
  }, 20_000)

  it.skipIf(binary == null)('runs native node:test and retains a Guest exception', async () => {
    const home = await mkdtemp(join(tmpdir(), 'holonomy-native-test-service-'))
    const service = createHolonomyService({
      nativeExecutablePath: binary,
      port: 0,
      stateDirectory: join(home, 'state'),
      token
    })
    try {
      await service.start()
      const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
      await client.call('/v1/devices:refresh', { body: {}, method: 'POST' })
      const input = launch("import test from 'node:test'; test('native_case', () => {})", { command: 'test' })
      const admitted = await client.launchProcess(input, 'native-test-start')
      const replay = await client.launchProcess(input, 'native-test-start')
      assert.equal(replay.value.process.id, admitted.value.process.id)
      const id = admitted.value.process.id
      await waitFor(
        () => client.getOperation(admitted.value.operation.id),
        operation => operation.state === 'succeeded',
        'test start'
      )
      await waitFor(() => client.getProcess(id), process => process.state === 'exited', 'native test exit')
      const page = await waitFor(
        () => client.readLogs(id, { after: 0, limit: 100 }),
        logs => logs.events.some(event => event.chunk.includes('TAP version 13')),
        'native TAP output'
      )
      assert.ok(page.events.some(event => event.chunk.includes('native_case')))
      await client.removeProcess(id, 1, 'native-test-remove')

      const thrown = await client.launchProcess(launch("throw new Error('NATIVE_THROW_MARKER')"), 'native-throw')
      const failedId = thrown.value.process.id
      await waitFor(
        () => client.getOperation(thrown.value.operation.id),
        operation => operation.state === 'succeeded',
        'throw start'
      )
      await waitFor(() => client.getProcess(failedId), process => process.state === 'failed', 'throw exit')
      const errors = await waitFor(
        () => client.readLogs(failedId, { after: 0, limit: 100 }),
        logs => logs.events.some(event => event.chunk.includes('NATIVE_THROW_MARKER')),
        'retained exception'
      )
      assert.ok(errors.events.some(event => event.stream === 'stderr'))
      await client.removeProcess(failedId, 1, 'native-throw-remove')
    } finally {
      await service.close()
      await rm(home, { force: true, recursive: true })
    }
  }, 20_000)

  it.skipIf(binary == null)('runs the public CLI snapshot through the same Native Service', async () => {
    const home = await mkdtemp(join(tmpdir(), 'holonomy-native-cli-home-'))
    const fixture = await mkdtemp(join(process.cwd(), 'work', 'native-cli-fixture-'))
    const source = join(fixture, 'entry.mjs')
    await writeFile(source, "console.log('CLI_NATIVE_OK', process.argv[2])\n")
    const service = createHolonomyService({
      nativeExecutablePath: binary,
      port: 0,
      stateDirectory: join(home, 'state'),
      token
    })
    try {
      await service.start()
      const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
      const output = []
      const parsed = parseHolonomyArgs([
        'run',
        '--target',
        'native',
        '--arg',
        'cli',
        relative(process.cwd(), source)
      ])
      const code = await runHolonomyRuntimeCommand(parsed, {
        stderr: { write: chunk => output.push(chunk) },
        stdout: { write: chunk => output.push(chunk) }
      }, {
        createClient: () => client,
        nativeSourceExecutablePath: binary,
        ensureService: async () => undefined
      })
      assert.equal(code, 0)
      assert.match(output.join(''), /CLI_NATIVE_OK cli/u)
      const testSource = join(fixture, 'native.test.mjs')
      await writeFile(testSource, "import test from 'node:test'; test('cli_native_test', () => {})\n")
      const testCode = await runHolonomyRuntimeCommand(
        parseHolonomyArgs(['test', '--target', 'native', relative(process.cwd(), testSource)]),
        {
          stderr: { write: chunk => output.push(chunk) },
          stdout: { write: chunk => output.push(chunk) }
        },
        { createClient: () => client, nativeSourceExecutablePath: binary, ensureService: async () => undefined }
      )
      assert.equal(testCode, 0)
      assert.match(output.join(''), /TAP version 13[\s\S]*cli_native_test/u)
      const plugin = join(fixture, 'permission.mjs')
      const config = join(fixture, 'holo.config.json')
      const capability = join(fixture, 'capability.json')
      const gated = join(fixture, 'gated.mjs')
      await writeFile(
        plugin,
        `export default (ctx) => {
        ctx.holo.intercept({operation:'system.os.arch.read'},
          invocation => ctx.holo.deny(invocation), {execution:'sync'});
      }`
      )
      await writeFile(config, JSON.stringify({ plugins: [{ id: 'permission', use: './permission.mjs' }] }))
      await writeFile(
        capability,
        JSON.stringify({
          context: { schemaVersion: 1 },
          initialMiddlewareId: 'service.continue.v1',
          sandboxPolicy: {
            device: {
              defaultAccess: 'deny',
              maxEventsPerSecond: 1,
              maxQueuedEvents: 0,
              maxSubscriptions: 0,
              operations: {}
            },
            filesystem: { access: 'none' },
            schemaVersion: 2,
            systemInformation: {
              defaultMode: 'unavailable',
              fields: {
                'os.arch': { allowedModes: ['synthetic'], maxPrecision: 'exact' }
              }
            }
          },
          schemaVersion: 1
        })
      )
      await writeFile(
        gated,
        `import os from 'node:os';
        try { os.arch(); console.log('CLI_PLUGIN_MISSING') }
        catch (error) { console.log('CLI_PLUGIN_DENY:' + error.code) }`
      )
      const pluginOutput = []
      const pluginCode = await runHolonomyRuntimeCommand(
        parseHolonomyArgs([
          'run',
          '--target',
          'native',
          '--config',
          config,
          '--capability-runtime',
          capability,
          relative(process.cwd(), gated)
        ]),
        {
          stderr: { write: chunk => pluginOutput.push(chunk) },
          stdout: { write: chunk => pluginOutput.push(chunk) }
        },
        { createClient: () => client, nativeSourceExecutablePath: binary, ensureService: async () => undefined }
      )
      assert.equal(pluginCode, 0)
      assert.match(pluginOutput.join(''), /CLI_PLUGIN_DENY:ERR_ACCESS_DENIED/u)
      assert.doesNotMatch(pluginOutput.join(''), /CLI_PLUGIN_MISSING/u)
    } finally {
      await service.close()
      await rm(home, { force: true, recursive: true })
      await rm(fixture, { force: true, recursive: true })
    }
  }, 20_000)

  it.skipIf(binary == null)('selects the executable from owner-only Service configuration', async () => {
    const home = await mkdtemp(join(tmpdir(), 'holonomy-native-owner-home-'))
    const path = join(home, 'native-runtime.json')
    await writeFile(path, JSON.stringify({ executablePath: binary, schemaVersion: 1 }), { mode: 0o600 })
    const manager = createHolonomyServiceLifecycleManager({ home, service: { port: 0 } })
    try {
      assert.equal(await readServiceNativeRuntimeInstallation(home), binary)
      const started = await manager.ensure()
      assert.equal(started.running, true)
      const client = new HolonomyServiceClient({ home })
      const devices = await client.call('/v1/devices:refresh', { body: {}, method: 'POST' })
      assert.ok(devices.some(device => device.id === 'native:local'))
      await chmod(path, 0o644)
      await assert.rejects(readServiceNativeRuntimeInstallation(home))
    } finally {
      await manager.stop({ drain: true })
      await rm(home, { force: true, recursive: true })
    }
  }, 20_000)

  it.skipIf(binary == null)('cancels a Native child when its Service owner is SIGKILLed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'holonomy-native-owner-death-'))
    const daemon = spawn(process.execPath, [childServiceEntry, home, binary], {
      env: { ...process.env, HOLONOMY_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    const messages = []
    let daemonErrors = ''
    daemon.on('message', message => messages.push(message))
    daemon.stderr.on('data', chunk => {
      daemonErrors += chunk.toString('utf8').slice(0, 4096)
    })
    try {
      const ready = await waitFor(
        async () => messages.find(message => message.type === 'ready'),
        Boolean,
        'child Service startup'
      )
      const client = new HolonomyServiceClient({ baseUrl: ready.baseUrl, token })
      await client.call('/v1/devices:refresh', { body: {}, method: 'POST' })
      const started = await client.launchProcess(
        launch('setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 15000)'),
        'native-owner-death'
      )
      await waitFor(
        () => client.getOperation(started.value.operation.id),
        operation => operation.state === 'succeeded',
        'owner death launch'
      )
      const owned = await waitFor(
        async () => messages.find(message => message.type === 'native-child'),
        message => Number.isSafeInteger(message?.pid),
        'known Native child PID'
      )
      assert.deepEqual(owned.args, ['__runtime'])
      assert.equal(runningPid(owned.pid), true)
      daemon.kill('SIGKILL')
      await waitFor(async () => daemon.exitCode ?? daemon.signalCode, Boolean, 'Service SIGKILL')
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && runningPid(owned.pid)) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.equal(runningPid(owned.pid), false, 'owned Native Runtime must exit after stdin EOF')
      const recovered = createHolonomyService({
        nativeExecutablePath: binary,
        port: 0,
        stateDirectory: join(home, 'state'),
        token
      })
      try {
        await recovered.start()
        const recoveredClient = new HolonomyServiceClient({ baseUrl: recovered.baseUrl, token })
        const current = await recoveredClient.getProcess(started.value.process.id)
        assert.equal(current.state, 'lost')
        assert.notEqual(current.cleanupPending, true)
        await recoveredClient.removeProcess(current.id, current.generation, 'native-recovered-remove')
        await assert.rejects(
          stat(join(home, 'state', 'native-processes', current.id)),
          error => error.code === 'ENOENT'
        )
      } finally {
        await recovered.close()
      }
    } catch (error) {
      assert.fail(`${error.message}; child Service stderr: ${daemonErrors}`)
    } finally {
      if (daemon.exitCode == null && daemon.signalCode == null) daemon.kill('SIGKILL')
      await rm(home, { force: true, recursive: true })
    }
  }, 20_000)

  it.skipIf(binary == null)(
    'rejects undeclared query aliases without changing standalone Native behavior',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'holonomy-native-alias-service-'))
      const standalone = await mkdtemp(join(tmpdir(), 'holonomy-native-alias-standalone-'))
      const service = createHolonomyService({
        nativeExecutablePath: binary,
        port: 0,
        stateDirectory: join(home, 'state'),
        token
      })
      try {
        await writeFile(join(standalone, 'entry.mjs'), "import './side-effect.mjs?alias=1'\n")
        await writeFile(join(standalone, 'side-effect.mjs'), "console.log('STANDALONE_QUERY_OK')\n")
        const direct = spawnSync(binary, ['run', join(standalone, 'entry.mjs')], {
          env: { PATH: '' },
          encoding: 'utf8',
          timeout: 5_000
        })
        assert.equal(direct.status, 0, direct.stderr)
        assert.match(direct.stdout, /STANDALONE_QUERY_OK/u)

        await service.start()
        const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
        await client.call('/v1/devices:refresh', { body: {}, method: 'POST' })
        const input = launch("import 'app://workspace/side-effect.mjs?alias=1'; console.log('UNSAFE_EXECUTED')")
        input.launch.modules.push({
          source: "console.log('ALIAS_SIDE_EFFECT')",
          url: 'app://workspace/side-effect.mjs'
        })
        const admitted = await client.launchProcess(input, 'native-query-alias')
        await waitFor(
          () => client.getOperation(admitted.value.operation.id),
          operation => operation.state === 'succeeded',
          'query alias start'
        )
        const current = await waitFor(
          () => client.getProcess(admitted.value.process.id),
          process => process.state === 'failed',
          'query alias rejection'
        )
        const logs = await client.readLogs(current.id, { after: 0, limit: 100 })
        assert.equal(logs.events.some(event => /UNSAFE_EXECUTED|ALIAS_SIDE_EFFECT/u.test(event.chunk)), false)
        await client.removeProcess(current.id, current.generation, 'native-query-remove')
      } finally {
        await service.close()
        await rm(home, { force: true, recursive: true })
        await rm(standalone, { force: true, recursive: true })
      }
    },
    20_000
  )
})
