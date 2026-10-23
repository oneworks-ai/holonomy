import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'

import { runtimePluginBundleDigestV1 } from '../../../packages/runtime/src/app/plugin-bundle.ts'
import { prepareHolonomyRuntimePlugins } from '../../holonomy-plugin-bundle.mjs'
import { createNativeRuntimeAdapter } from '../native-target-adapter.mjs'
import { createHolonomyService } from '../server.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'
import { createNativeInflightHttpFixture, nativeInflightBounded } from './native-inflight-http-fixture.mjs'
import { nativeLogContains } from './native-log-text.mjs'

const executable = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const token = 'native-inflight-public-token-at-least-32-bytes'
const entryUrl = 'app://workspace/index.mjs'
const pluginSource = `export default (ctx, config) => {
  ctx.holo.intercept({ operation: 'network.fetch.request' },
    (invocation, next) => config.mode === 'deny' ? ctx.holo.deny(invocation) : next(),
    { execution: 'async' });
  ctx.holo.intercept({ operation: 'system.os.arch.read' },
    (invocation, next) => config.mode === 'deny' ? ctx.holo.deny(invocation) : next(),
    { execution: 'sync' });
}`
const guestRevisionSource = origin => `
import assert from 'node:assert/strict';
import os from 'node:os';
const old = fetch('${origin}/held').then(value => ({ ok: true, value }), error => ({ ok: false, error }));
const ticker = setInterval(() => {
  try {
    assert.equal(typeof os.arch(), 'string');
  } catch (error) {
    clearInterval(ticker);
    if (error.code !== 'ERR_ACCESS_DENIED') {
      console.log('INFLIGHT_GUEST_FAILURE:' + error.code);
      return;
    }
    void (async () => {
      await assert.rejects(fetch('${origin}/new'), { code: 'holo.permission_denied' });
      console.log('INFLIGHT_FRESH_DENIED');
      const result = await old;
      assert.equal(result.ok, true, String(result.error));
      assert.equal(result.value.status, 200);
      assert.equal(await result.value.text(), 'old-approved');
      console.log('INFLIGHT_OLD_ALLOWED');
    })().catch(failure => console.log('INFLIGHT_GUEST_FAILURE:' + failure));
  }
}, 20);
`
const guestGenerationSource = origin => `
import assert from 'node:assert/strict';
const result = await fetch('${origin}/held');
assert.equal(result.status, 200);
console.log('INFLIGHT_GENERATION_RESULT:' + await result.text());
const fresh = await fetch('${origin}/fresh-latch');
assert.equal(await fresh.text(), 'fresh-latch');
console.log('INFLIGHT_GENERATION_FINAL');
`
const policy = origin => ({
  device: { defaultAccess: 'deny', maxEventsPerSecond: 1, maxQueuedEvents: 0, maxSubscriptions: 0, operations: {} },
  filesystem: { access: 'none' },
  network: {
    access: 'restricted',
    allowedOrigins: [origin],
    allowedSchemes: ['http'],
    allowPrivateNetwork: true,
    limits: {
      maxChunkBytes: 1024,
      maxConcurrentConnections: 1,
      maxHeaderBytes: 4096,
      maxHeaders: 32,
      maxRedirects: 10,
      maxRequestBodyBytes: 4096,
      maxResponseBodyBytes: 4096,
      maxUrlBytes: 4096,
      socketTimeoutMs: 60_000
    },
    requestBodyInspection: { access: 'none' }
  },
  schemaVersion: 2,
  systemInformation: {
    defaultMode: 'unavailable',
    fields: { 'os.arch': { allowedModes: ['synthetic'], maxPrecision: 'exact' } }
  }
})
const until = async (read, accepts, label, durationMs = 12_000) => {
  const deadline = Date.now() + durationMs
  let latest
  do {
    latest = await read()
    if (accepts(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  assert.fail(`${label}: ${JSON.stringify(latest)}`)
}
const launch = (source, origin, bundles) => ({
  capabilityRuntime: {
    context: {
      guest: { application: { id: 'native.inflight.public', name: 'Native Inflight' } },
      host: { tenantId: 'isolated-inflight-fixture' },
      schemaVersion: 1
    },
    initialMiddlewareId: 'service.continue.v1',
    sandboxPolicy: policy(origin),
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
    modules: [{ source, url: entryUrl }],
    reporter: 'tap',
    schemaVersion: 2,
    target: 'native'
  },
  runtimePlugins: bundles,
  sandboxPolicy: {
    filesystem: { access: 'none' },
    network: {
      access: 'restricted',
      allowedOrigins: [origin],
      allowedSchemes: ['http'],
      allowPrivateNetwork: true,
      limits: {
        maxChunkBytes: 1024,
        maxConcurrentConnections: 1,
        maxHeaderBytes: 4096,
        maxHeaders: 32,
        maxRequestBodyBytes: 4096,
        maxResponseBodyBytes: 4096,
        maxUrlBytes: 4096,
        socketTimeoutMs: 60_000
      }
    },
    schemaVersion: 1
  },
  target: 'native'
})

const withFixture = async work => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-native-inflight-')))
  const home = join(root, 'home')
  const stateDirectory = join(home, 'state')
  const configPath = join(root, 'holo.config.json')
  const pluginRoot = join(root, 'plugin-package')
  let service
  let server
  let processId
  const children = []
  const cleanupFailures = []
  let primaryFailure
  let hasPrimaryFailure = false
  const attemptCleanup = async (label, action) => {
    try {
      await nativeInflightBounded(Promise.resolve().then(action), label)
    } catch (error) {
      cleanupFailures.push(error)
      process.stderr.write(`NATIVE_INFLIGHT_CLEANUP_FAILURE ${label}: ${String(error).slice(0, 300)}\n`)
    }
  }
  try {
    await mkdir(home)
    await mkdir(pluginRoot)
    await writeFile(join(pluginRoot, 'index.mjs'), pluginSource)
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
    const bundles = async (mode, sequence) => {
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: [{ config: { mode, sequence }, id: 'inflight', use: './plugin-package' }]
        })
      )
      return prepareHolonomyRuntimePlugins(configPath).bundles
    }
    server = await createNativeInflightHttpFixture()
    const adapter = createNativeRuntimeAdapter({
      executablePath: executable,
      stateDirectory,
      spawn(file, args, options) {
        const child = spawn(file, args, { ...options, env: { ...options.env, HOLONOMY_HOME: home, PATH: '' } })
        const owned = { child, closed: false }
        owned.completed = new Promise(resolve =>
          child.once('close', (code, signal) => {
            owned.closed = true
            resolve({ code, signal })
          })
        )
        child.once('error', error => owned.spawnError = error)
        children.push(owned)
        return child
      }
    })
    service = createHolonomyService({ nativeAdapter: adapter, port: 0, stateDirectory, token })
    await service.start()
    const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
    await client.call('/v1/devices:refresh', { body: {}, method: 'POST' })
    const start = async source => {
      const admitted = await client.launchProcess(
        launch(source, server.origin, await bundles('allow', 0)),
        randomUUID()
      )
      processId = admitted.value.process.id
      const operation = await until(
        () => client.getOperation(admitted.value.operation.id),
        value => ['succeeded', 'failed'].includes(value.state),
        'Native launch'
      )
      assert.equal(operation.state, 'succeeded', JSON.stringify(operation))
      return processId
    }
    const operation = async admitted =>
      until(
        () => client.getOperation(admitted.value.operation.id),
        value => ['succeeded', 'failed', 'cancelled'].includes(value.state),
        'Service operation'
      )
    const logs = (generation, marker) =>
      until(
        () => client.readLogs(processId, { after: 0, limit: 512 }),
        page => nativeLogContains(page, marker, generation),
        `Native log ${marker} generation ${generation}`
      )
    await work({ bundles, children, client, logs, operation, server, start })
  } catch (error) {
    primaryFailure = error
    hasPrimaryFailure = true
  } finally {
    if (processId != null && service != null) {
      await attemptCleanup('Service stop', async () => {
        const current = await new HolonomyServiceClient({ baseUrl: service.baseUrl, token }).getProcess(processId)
        if (current.state === 'running') {
          const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
          const stopped = await client.processAction(processId, 'stop', current.generation, randomUUID())
          await until(
            () => client.getOperation(stopped.value.operation.id),
            value => value.state === 'succeeded',
            'cleanup stop'
          )
        }
      })
    }
    await attemptCleanup('Service close', async () => {
      if (service == null) return
      await service.close()
      assert.equal(service.server.listening, false)
    })
    for (const owned of children) {
      await attemptCleanup(`owned child ${owned.child.pid} kill`, async () => {
        if (!owned.closed && owned.child.exitCode == null && owned.child.signalCode == null) {
          owned.child.kill('SIGKILL')
        }
      })
      await attemptCleanup(`owned child ${owned.child.pid} close`, async () => {
        await nativeInflightBounded(owned.completed, 'owned Native child close')
        if (owned.spawnError != null) throw owned.spawnError
      })
    }
    await attemptCleanup('HTTP fixture close', async () => server?.close())
    if (cleanupFailures.length === 0 && children.every(owned => owned.closed)) {
      await attemptCleanup('fixture root', async () => rm(root, { force: true, recursive: true }))
    } else {
      process.stderr.write(`NATIVE_INFLIGHT_FIXTURE_RETAINED ${root}\n`)
    }
  }
  if (hasPrimaryFailure) throw primaryFailure
  if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'Native inflight fixture cleanup failed')
}

it.skipIf(executable == null || process.platform !== 'darwin')(
  'keeps an acknowledged old Native fetch on its plugin graph across 24 revisions and candidate rejection',
  async () =>
    withFixture(async ({ bundles, client, logs, operation, server, start }) => {
      const processId = await start(guestRevisionSource(server.origin))
      await server.waitForHeld()
      assert.deepEqual(server.requests(), ['/held'], 'the held call entered the real Native transport')
      let revision = (await client.getProcess(processId)).pluginGraphRevision
      assert.equal(revision, 1)
      for (let sequence = 1; sequence <= 24; sequence += 1) {
        if (sequence === 12) {
          const valid = await bundles('allow', sequence - 1)
          const malformed = valid.map(bundle => {
            const invalid = { ...bundle, config: { mode: 'allow', sequence: 'invalid-schema' } }
            return { ...invalid, bundleSha256: runtimePluginBundleDigestV1(invalid) }
          })
          const rejected = await client.replaceRuntimePlugins(
            processId,
            { expectedGeneration: 1, runtimePlugins: malformed },
            revision,
            randomUUID()
          )
          assert.equal((await operation(rejected)).state, 'failed')
          assert.equal((await client.getProcess(processId)).pluginGraphRevision, revision)
          assert.deepEqual(server.requests(), ['/held'])
        }
        const mode = sequence === 24 ? 'deny' : 'allow'
        const admitted = await client.replaceRuntimePlugins(
          processId,
          { expectedGeneration: 1, runtimePlugins: await bundles(mode, sequence) },
          revision,
          randomUUID()
        )
        assert.equal((await operation(admitted)).state, 'succeeded')
        revision += 1
        assert.equal((await client.getProcess(processId)).pluginGraphRevision, revision)
      }
      await logs(1, 'INFLIGHT_FRESH_DENIED')
      assert.deepEqual(server.requests(), ['/held'], 'fresh denial must precede loopback I/O')
      server.releaseHeld()
      const page = await logs(1, 'INFLIGHT_OLD_ALLOWED')
      assert.equal(nativeLogContains(page, 'INFLIGHT_GUEST_FAILURE', 1), false)
      assert.equal(revision, 25)
      const ended = await until(
        () => client.getProcess(processId),
        value => value.state === 'exited',
        'old-graph Guest natural exit'
      )
      assert.equal(ended.exit?.code, 0)
    }),
  90_000
)

// This is cancellation/transport recovery evidence. A dead generation cannot
// receive a real late Host terminal through its already closed network socket.
for (
  const [reasonMode, abortExpression] of [
    ['default', 'controller.abort()'],
    ['object', "controller.abort({ label: 'guest-local' })"],
    ['null', 'controller.abort(null)'],
    ['false', 'controller.abort(false)'],
    ['zero', 'controller.abort(0)'],
    ['string', "controller.abort('guest-local')"]
  ]
) {
  it.skipIf(executable == null || process.platform !== 'darwin')(
    `releases the one-connection Native quota after aborting an admitted response body (${reasonMode})`,
    async () =>
      withFixture(async ({ children, client, logs, server, start }) => {
        const processId = await start(`
import assert from 'node:assert/strict';
const controller = new AbortController();
const response = await fetch('${server.origin}/held', { signal: controller.signal });
assert.equal(response.status, 200);
const body = response.text();
${abortExpression};
let rejected = false;
await body.then(() => assert.fail('aborted body must reject'), error => {
  rejected = true;
  assert.equal(error, controller.signal.reason);
  if ('${reasonMode}' === 'default') assert.equal(error.name, 'AbortError');
});
assert.equal(rejected, true);
console.log('INFLIGHT_ABORT_ERROR:' + JSON.stringify({ mode: '${reasonMode}', identityPreserved: true }));
console.log('INFLIGHT_ABORTED');
const fresh = await fetch('${server.origin}/fresh-quota');
assert.equal(await fresh.text(), 'fresh-quota');
console.log('INFLIGHT_QUOTA_RECOVERED');
`)
        await server.waitForHeld()
        assert.deepEqual(server.requests(), ['/held'])
        assert.equal(server.heldSocketClosed(), false)
        server.releaseHeldHeaders()
        await server.waitForHeldClose()
        const page = await logs(1, 'INFLIGHT_QUOTA_RECOVERED')
        assert.equal(nativeLogContains(page, 'INFLIGHT_ABORTED', 1), true)
        const stdout = page.events.filter(event => event.generation === 1 && event.stream === 'stdout')
          .map(event => event.chunk).join('')
        const snapshot = stdout.match(/INFLIGHT_ABORT_ERROR:([^\n]+)/u)?.[1]
        assert.equal(typeof snapshot, 'string')
        assert.deepEqual(JSON.parse(snapshot), { mode: reasonMode, identityPreserved: true })
        process.stdout.write(`NATIVE_INFLIGHT_ABORT_ERROR ${snapshot}\n`)
        assert.deepEqual(server.requests(), ['/held', '/fresh-quota'])
        const ended = await until(
          () => client.getProcess(processId),
          value => value.state === 'exited',
          'quota-recovered Guest natural exit'
        )
        assert.equal(ended.exit?.code, 0)
        assert.deepEqual(await nativeInflightBounded(children[0].completed, 'quota child close'), {
          code: 0,
          signal: null
        })
        process.stdout.write(
          'NATIVE_INFLIGHT_ABORT_EVIDENCE {"heldSocketClosed":true,"connectionLimit":1,"freshRequestCompleted":true,"childClosed":true}\n'
        )
      }),
    30_000
  )
}

for (const interruption of ['restart', 'stop', 'SIGKILL']) {
  it.skipIf(executable == null || process.platform !== 'darwin')(
    `closes an admitted old Native transport after ${interruption} and naturally completes the recovered generation`,
    async () =>
      withFixture(async ({ children, client, logs, operation, server, start }) => {
        const processId = await start(guestGenerationSource(server.origin))
        await server.waitForHeld()
        assert.deepEqual(server.requests(), ['/held'])
        assert.equal(server.heldSocketClosed(), false)
        assert.equal(children.length, 1)
        const previous = children[0]
        if (interruption === 'stop') {
          const stopped = await client.processAction(processId, 'stop', 1, randomUUID())
          assert.equal((await operation(stopped)).state, 'succeeded')
          assert.equal((await client.getProcess(processId)).state, 'cancelled')
        } else if (interruption === 'SIGKILL') {
          assert.equal(previous.child.kill('SIGKILL'), true)
          const failed = await until(
            () => client.getProcess(processId),
            value => value.state === 'failed',
            'interrupted Native failure publication'
          )
          assert.equal(failed.generation, 1)
        }
        if (interruption !== 'restart') {
          await nativeInflightBounded(previous.completed, 'interrupted child close')
          await server.waitForHeldClose()
        }
        const restarted = await client.processAction(processId, 'restart', 1, randomUUID())
        assert.equal((await operation(restarted)).state, 'succeeded')
        const retired = await nativeInflightBounded(previous.completed, 'retired child close')
        if (interruption === 'SIGKILL') assert.equal(retired.signal, 'SIGKILL')
        await server.waitForHeldClose()
        assert.equal(server.heldSocketClosed(), true)
        assert.equal((await client.getProcess(processId)).generation, 2)
        await logs(2, 'INFLIGHT_GENERATION_RESULT:fresh-generation')
        await server.waitForFreshLatch()
        assert.equal(children.length, 2)
        assert.notEqual(children[1].child.pid, previous.child.pid)
        server.releaseFreshLatch()
        const page = await logs(2, 'INFLIGHT_GENERATION_FINAL')
        assert.equal(nativeLogContains(page, 'INFLIGHT_GENERATION_RESULT:', 1), false)
        assert.deepEqual(server.requests(), ['/held', '/held', '/fresh-latch'])
        const ended = await until(
          () => client.getProcess(processId),
          value => value.state === 'exited',
          'new-generation Guest natural exit'
        )
        assert.equal(ended.exit?.code, 0)
        assert.deepEqual(await nativeInflightBounded(children[1].completed, 'recovered child close'), {
          code: 0,
          signal: null
        })
        await assert.rejects(client.processAction(processId, 'stop', 1, randomUUID()))
        process.stdout.write(`NATIVE_INFLIGHT_GENERATION_EVIDENCE ${
          JSON.stringify({
            interruption,
            oldTransportAccepted: true,
            oldSocketClosed: true,
            retiredChildClosed: true,
            recoveredGeneration: 2,
            recoveredChildClosed: true,
            recoveredExitCode: 0,
            lateHostTerminalInjected: false
          })
        }\n`)
      }),
    30_000
  )
}
