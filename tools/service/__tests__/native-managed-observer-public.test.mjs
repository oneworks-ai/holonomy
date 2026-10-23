/* eslint-disable max-lines -- real Native public admission and observer lifecycle share one fixture. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

import { prepareHolonomyRuntimePlugins } from '../../holonomy-plugin-bundle.mjs'
import { createHolonomyServiceLifecycleManager } from '../lifecycle-manager.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'
import { nativeLogContains } from './native-log-text.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../../../target/debug/holo', import.meta.url))
const cli = fileURLToPath(new URL('../../holonomy.mjs', import.meta.url))
const privateMarker = 'HOST_OBSERVER_PRIVATE_CONTEXT_SENTINEL'
const guestMarker = 'GUEST_OBSERVER_RAW_SOURCE_SENTINEL'
const terminalStates = new Set(['cancelled', 'exited', 'failed', 'lost'])
const engineEvents = ['script.compiled', 'script.execution-started', 'script.execution-finished']
const observedEvents = [...engineEvents, 'runtime.exception', 'runtime.terminated']
const digest = value => createHash('sha256').update(value).digest('hex')

const policy = (events = observedEvents, maxQueuedEvents = 32, maxObserverCallbackMs = 1000) => ({
  codeGeneration: {
    dynamicImport: { access: 'none' },
    strings: { access: 'controlled', decisionTimeoutMs: 1000, maxOperations: 128, maxSourceBytes: 1024 },
    wasm: { access: 'none' }
  },
  diagnostics: {
    maxObserverCallbackMs,
    maxQueuedEvents,
    maxSourceReadBytes: 0,
    observerEvents: events,
    retentionMs: 0,
    sourceReader: 'none'
  },
  schemaVersion: 2
})

const observedPlugin = `
const privateContext = '${privateMarker}';
export default (ctx, config) => {
  const compiled = new Map(), started = new Map();
  let safe = true, finishedDependency = false;
  const testWrapperRoot = new RegExp('^app://workspace/test-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]mjs$');
  const explicitRoot = origin => config.testWrapperRoot
    ? testWrapperRoot.test(origin)
    : origin === config.root;
  ctx.holo.observe({
    acceptHighCost: true, callbackTimeoutMs: 100, maxQueuedEvents: 32,
    events: ['script.compiled', 'script.execution-started', 'script.execution-finished', 'runtime.exception', 'runtime.terminated']
  }, event => {
    const encoded = JSON.stringify(event);
    safe &&= Object.isFrozen(event) && Object.isFrozen(event.payload) &&
      event.schemaVersion === 1 && event.generation === 1 &&
      Number.isFinite(event.observedAt) && Number.isSafeInteger(event.sequence) &&
      !encoded.includes('${guestMarker}') && !encoded.includes(privateContext) &&
      !('source' in event.payload) && !('context' in event.payload) &&
      !('callback' in event.payload);
    if (event.event === 'script.compiled') {
      safe &&= /^[0-9a-f]{64}$/.test(event.payload.sourceSha256) && event.payload.sourceBytes > 0;
      compiled.set(event.payload.scriptId, event.payload.origin);
    }
    if (event.event === 'script.execution-started')
      started.set(event.payload.executionId, event.payload.scriptId);
    if (event.event === 'script.execution-finished')
      finishedDependency ||= event.payload.outcome === 'completed' &&
        started.get(event.payload.executionId) === event.payload.scriptId &&
        compiled.get(event.payload.scriptId) === config.dependency;
    if (event.event === 'runtime.terminated') throw Error('private observer terminal marker');
  });
  // Test-only handshake: Observer metadata is never business authorization.
  ctx.holo.engineGate(request => request.operation === 'runtime.code.generate.strings' && safe &&
      [...compiled.values()].includes(config.root) &&
      [...compiled.values()].includes(config.dependency) &&
      [...started.values()].some(scriptId => explicitRoot(compiled.get(scriptId))) &&
      (!config.requireFinishedDependency || finishedDependency)
      ? { action: 'allow' }
      : { action: 'deny', reasonCode: 'host.observer_pending' });
};`

const faultPlugin = `
export default ctx => {
  let calls = 0;
  ctx.holo.observe({
    acceptHighCost: true, callbackTimeoutMs: 20, maxQueuedEvents: 1,
    events: ['script.compiled', 'script.execution-started', 'script.execution-finished']
  }, () => {
    if (++calls === 1) throw Error('private observer throw marker');
    if (calls === 2) return new Promise(() => {});
  });
  ctx.holo.engineGate(() => ({ action: 'allow' }));
};`

const revisionPlugin = `
export default (ctx, config) => {
  let seen = false;
  ctx.holo.observe({ acceptHighCost: true, callbackTimeoutMs: 1000, events: ['script.compiled'] }, event => {
    if (event.payload.origin === config.watchOrigin) {
      seen = true;
      if (config.tag === 'A') return new Promise(() => {});
    }
  });
  ctx.holo.engineGate(request => request.operation === 'runtime.code.generate.strings' && (
      config.tag === 'A' && seen && request.sourceSha256 === config.oldSha ||
      config.tag === 'B' && (request.sourceSha256 === config.probeSha ||
        seen && request.sourceSha256 === config.newSha)
    ) ? { action: 'allow' } : { action: 'deny', reasonCode: 'host.observer_revision_pending' });
};`

const fixture = async (
  {
    events = observedEvents,
    observerRegistry,
    plugin = observedPlugin,
    pluginConfig = {},
    maxQueuedEvents = 32,
    maxObserverCallbackMs = 1000,
    initialObserverIds
  } = {}
) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-native-managed-observer-')))
  const home = join(root, 'home')
  const project = join(root, 'project')
  try {
    await mkdir(home)
    await mkdir(project)
    await writeFile(join(home, 'native-runtime.json'), JSON.stringify({ executablePath: binary, schemaVersion: 1 }), {
      mode: 0o600
    })
    await writeFile(join(project, 'observer.mjs'), plugin)
    await writeFile(
      join(project, 'holo.config.json'),
      JSON.stringify({
        plugins: [{ config: pluginConfig, id: 'observer', use: './observer.mjs' }]
      })
    )
    await writeFile(
      join(project, 'capability.json'),
      JSON.stringify({
        context: {
          guest: { application: { id: 'native.managed.observer', name: 'Native managed observer' } },
          host: { tenantId: privateMarker },
          schemaVersion: 1
        },
        initialMiddlewareId: 'service.continue.v1',
        ...(initialObserverIds == null ? {} : { initialObserverIds }),
        sandboxPolicy: policy(events, maxQueuedEvents, maxObserverCallbackMs),
        schemaVersion: 1
      })
    )
    const client = new HolonomyServiceClient({ home, environment: {} })
    const manager = createHolonomyServiceLifecycleManager({
      client,
      home,
      service: { capabilityObserverRegistry: observerRegistry, port: 0 }
    })
    return { client, home, manager, project, root }
  } catch (error) {
    await rm(root, { force: true, recursive: true })
    throw error
  }
}

const startCli = (f, url, command, entry, extra = []) => {
  const child = spawn(process.execPath, [
    cli,
    command,
    entry,
    '--target',
    'native',
    '--config',
    'holo.config.json',
    '--capability-runtime',
    'capability.json',
    '--openapi',
    `${url}/openapi.json`,
    '--openapi-token-file',
    join(f.home, 'token'),
    ...extra
  ], { cwd: f.project, env: { ...process.env, HOLONOMY_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = { stderr: '', stdout: '' }
  child.stdout.on('data', bytes => output.stdout += bytes)
  child.stderr.on('data', bytes => output.stderr += bytes)
  const completed = once(child, 'close')
  void completed.catch(() => undefined)
  return { child, completed, output }
}

const finish = async (running, timeoutMs = 15_000) => {
  const timer = setTimeout(() => running.child.kill('SIGKILL'), timeoutMs)
  try {
    const [code, signal] = await running.completed
    return { code, signal, ...running.output }
  } finally {
    clearTimeout(timer)
  }
}

const until = async (read, accepts, label) => {
  let latest
  for (let turn = 0; turn < 600; turn += 1) {
    latest = await read()
    if (accepts(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`${label} did not settle: ${JSON.stringify(latest)}`)
}

const logsUntil = (f, id, marker, generation) =>
  until(
    () => f.client.readLogs(id, { after: 0, limit: 512 }),
    page => nativeLogContains(page, marker, generation),
    `Native log ${marker} in generation ${generation}`
  )

const terminal = (f, id) =>
  until(
    () => f.client.getProcess(id),
    value => terminalStates.has(value.state) && value.cleanupPending !== true,
    'Native terminal'
  )

const remove = async (f, id) => {
  const current = await f.client.getProcess(id)
  if (!terminalStates.has(current.state)) {
    const stop = await f.client.processAction(id, 'stop', current.generation, randomUUID())
    await until(() => f.client.getOperation(stop.value.operation.id), value => value.state === 'succeeded', 'stop')
  }
  const ended = await terminal(f, id)
  await f.client.removeProcess(id, ended.generation, randomUUID())
}

const withService = async (options, body) => {
  const f = await fixture(options)
  let running
  try {
    running = await f.manager.ensure()
    return await body(f, running.endpoint.baseUrl)
  } finally {
    try {
      if (running != null) {
        for (const process of await f.client.call('/v1/processes')) await remove(f, process.id)
      }
    } finally {
      try {
        if (running != null) await f.manager.stop({ drain: true })
      } finally {
        await rm(f.root, { force: true, recursive: true })
      }
    }
  }
}

const guestHandshake = `
async function observerReady(expression) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { if (eval(expression) === 42) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw Error('observer event handshake did not complete');
}`

describe('public CLI -> Service -> Native managed Runtime Observer', () => {
  it.skipIf(process.platform !== 'darwin')(
    'reports source-free CJS and ESM engine metadata, Guest success and a fixed terminal diagnostic',
    async () => {
      await withService({}, async (f, url) => {
        await writeFile(join(f.project, 'dep.cjs'), 'exports.value = 41\n')
        await writeFile(
          join(f.project, 'index.cjs'),
          `
        const assert = require('node:assert/strict');
        const dep = require('./dep.cjs');
        const source = '${guestMarker}';
        ${guestHandshake}
        assert.equal(typeof globalThis.holo, 'undefined');
        observerReady('40+2').then(() => {
          assert.equal(dep.value + 1, 42);
          console.log('NATIVE_OBSERVER_CJS_OK', source.length);
        });
      `
        )
        await writeFile(
          join(f.project, 'holo.config.json'),
          JSON.stringify({
            plugins: [{
              config: {
                dependency: 'app://workspace/dep.cjs',
                requireFinishedDependency: true,
                root: 'app://workspace/index.cjs'
              },
              id: 'observer',
              use: './observer.mjs'
            }]
          })
        )
        const run = await finish(startCli(f, url, 'run', './index.cjs', ['--detach']))
        assert.equal(run.code, 0, run.stderr + run.stdout)
        const runId = JSON.parse(run.stdout).processId
        const ended = await terminal(f, runId)
        assert.equal(ended.exit?.code, 0, JSON.stringify(ended))
        const runLogs = await until(
          () => f.client.readLogs(runId, { after: 0, limit: 512 }),
          page =>
            ['NATIVE_OBSERVER_CJS_OK', 'holo observer callback.failed runtime.terminated']
              .every(marker => nativeLogContains(page, marker)),
          'CJS Guest success and fixed terminal diagnostic'
        )
        assert(!JSON.stringify(runLogs).includes(privateMarker))
        assert(!JSON.stringify(runLogs).includes(guestMarker))
        assert(!nativeLogContains(runLogs, privateMarker))
        assert(!nativeLogContains(runLogs, guestMarker))
        assert(!JSON.stringify(ended).includes(privateMarker))

        await writeFile(
          join(f.project, 'steal.mjs'),
          "import './observer.mjs'; console.log('GUEST_OBSERVER_CALLBACK_LEAK')"
        )
        const stolen = await finish(startCli(f, url, 'run', './steal.mjs', ['--detach']))
        assert.equal(stolen.code, 1, stolen.stderr + stolen.stdout)
        assert(!stolen.stdout.includes('GUEST_OBSERVER_CALLBACK_LEAK'))
        assert(!stolen.stderr.includes(privateMarker))

        await writeFile(join(f.project, 'dep.mjs'), 'export const value = 41\n')
        await writeFile(
          join(f.project, 'check.test.mjs'),
          `
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import { value } from './dep.mjs';
        const source = '${guestMarker}';
        ${guestHandshake}
        test('managed observer', async () => {
          assert.equal(typeof globalThis.holo, 'undefined');
          await observerReady('40+2');
          assert.equal(value + 1, 42);
          console.log('NATIVE_OBSERVER_ESM_OK', source.length);
        });
      `
        )
        await writeFile(
          join(f.project, 'holo.config.json'),
          JSON.stringify({
            plugins: [{
              config: {
                dependency: 'app://workspace/dep.mjs',
                requireFinishedDependency: false,
                root: 'app://workspace/check.test.mjs',
                testWrapperRoot: true
              },
              id: 'observer',
              use: './observer.mjs'
            }]
          })
        )
        const tested = await finish(startCli(f, url, 'test', './check.test.mjs', ['--reporter', 'json']))
        assert.equal(tested.code, 0, tested.stderr + tested.stdout)
        const report = tested.stdout.split('\n').map(line => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        }).find(value => value?.total === 1 && Array.isArray(value.results))
        assert(report, tested.stdout)
        assert.equal(report.passed, 1)
        assert(tested.stdout.includes('NATIVE_OBSERVER_ESM_OK'), tested.stdout)
        assert(!JSON.stringify(report).includes(privateMarker))
        assert(!JSON.stringify(report).includes(guestMarker))
      })
    },
    45_000
  )

  it.skipIf(process.platform !== 'darwin')(
    'rejects missing Policy, unsupported events and high cost without opt-in before Guest entry',
    async () => {
      const cases = [
        { events: [], registration: { events: ['script.compiled'] } },
        { events: ['gc.completed'], registration: { events: ['gc.completed'] } },
        { events: ['script.compiled'], registration: { events: ['script.compiled'] } }
      ]
      for (const [index, testCase] of cases.entries()) {
        await withService({
          events: testCase.events,
          plugin: `export default ctx => {
        ctx.holo.observe(${JSON.stringify(testCase.registration)}, () => {});
      }`
        }, async (f, url) => {
          await writeFile(join(f.project, 'index.mjs'), `console.log('OBSERVER_DENIED_ENTRY_${index}')`)
          const result = await finish(startCli(f, url, 'run', './index.mjs', ['--detach']))
          assert(!result.stdout.includes(`OBSERVER_DENIED_ENTRY_${index}`))
          assert(!result.stderr.includes(`OBSERVER_DENIED_ENTRY_${index}`))
          if (result.code === 0) {
            const id = JSON.parse(result.stdout).processId
            const ended = await terminal(f, id)
            assert.notEqual(ended.exit?.code, 0, JSON.stringify(ended))
            const logs = await f.client.readLogs(id, { after: 0, limit: 256 })
            assert(!JSON.stringify(logs).includes(`OBSERVER_DENIED_ENTRY_${index}`))
            assert(!nativeLogContains(logs, `OBSERVER_DENIED_ENTRY_${index}`))
          } else {
            assert.equal(result.code, 1, result.stderr + result.stdout)
            assert.equal((await f.client.call('/v1/processes')).length, 0)
          }
        })
      }
    },
    45_000
  )

  it.skipIf(process.platform !== 'darwin')(
    'rejects Native initialObserverIds despite an installed same-name Node observer',
    async () => {
      const observerRegistry = {
        'observer.same-name': {
          observer: () => undefined,
          registration: { events: ['runtime.terminated'] }
        }
      }
      await withService({
        events: ['runtime.terminated'],
        initialObserverIds: ['observer.same-name'],
        observerRegistry,
        plugin: 'export default () => undefined'
      }, async (f, url) => {
        await writeFile(join(f.project, 'index.mjs'), "console.log('NATIVE_INITIAL_OBSERVER_WRONG')")
        const result = await finish(startCli(f, url, 'run', './index.mjs', ['--detach']))
        assert.equal(result.code, 1, result.stderr + result.stdout)
        assert(!result.stdout.includes('NATIVE_INITIAL_OBSERVER_WRONG'))
        assert(!result.stderr.includes('NATIVE_INITIAL_OBSERVER_WRONG'))
        assert.equal((await f.client.call('/v1/processes')).length, 0)
      })
    },
    20_000
  )

  it.skipIf(process.platform !== 'darwin')(
    'reports fixed exception and failed-terminal diagnostics without exposing Host callback errors',
    async () => {
      await withService({
        events: ['runtime.exception', 'runtime.terminated'],
        plugin: `export default ctx => {
          ctx.holo.observe({ events: ['runtime.exception', 'runtime.terminated'] }, event => {
            if (event.event === 'runtime.exception' && event.payload.code === 'runtime.execution_failed')
              throw Error('HOST_EXCEPTION_CALLBACK_PRIVATE');
            if (event.event === 'runtime.terminated' && event.payload.reason === 'failed')
              throw Error('HOST_TERMINAL_CALLBACK_PRIVATE');
          });
        }`
      }, async (f, url) => {
        await writeFile(join(f.project, 'throws.mjs'), "throw Error('expected Guest failure')")
        const result = await finish(startCli(f, url, 'run', './throws.mjs', ['--detach']))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        const ended = await terminal(f, id)
        assert.notEqual(ended.exit?.code, 0, JSON.stringify(ended))
        const logs = await until(
          () => f.client.readLogs(id, { after: 0, limit: 256 }),
          page =>
            ['holo observer callback.failed runtime.exception', 'holo observer callback.failed runtime.terminated']
              .every(marker => nativeLogContains(page, marker)),
          'exception and terminal diagnostics'
        )
        assert(!JSON.stringify(logs).includes('HOST_EXCEPTION_CALLBACK_PRIVATE'))
        assert(!JSON.stringify(logs).includes('HOST_TERMINAL_CALLBACK_PRIVATE'))
        assert(!JSON.stringify(logs).includes(privateMarker))
        assert(!nativeLogContains(logs, 'HOST_EXCEPTION_CALLBACK_PRIVATE'))
        assert(!nativeLogContains(logs, 'HOST_TERMINAL_CALLBACK_PRIVATE'))
        assert(!nativeLogContains(logs, privateMarker))
      })
    },
    20_000
  )

  it.skipIf(process.platform !== 'darwin')(
    'isolates throw, timeout and overflow from Guest and Gate in a live Native process',
    async () => {
      await withService({
        events: engineEvents,
        maxObserverCallbackMs: 20,
        maxQueuedEvents: 1,
        plugin: faultPlugin
      }, async (f, url) => {
        for (let index = 0; index < 12; index += 1) {
          await writeFile(join(f.project, `dep${index}.cjs`), 'exports.value = 1\n')
        }
        await writeFile(
          join(f.project, 'fault.cjs'),
          `
        ${Array.from({ length: 12 }, (_, index) => `require('./dep${index}.cjs');`).join('\n')}
        if (eval('40+2') !== 42) throw Error('Gate was changed by Observer');
        console.log('OBSERVER_ISOLATED_OK');
        setInterval(() => {}, 1000);
      `
        )
        const result = await finish(startCli(f, url, 'run', './fault.cjs', ['--detach']))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        const logs = await until(
          () => f.client.readLogs(id, { after: 0, limit: 512 }),
          page =>
            [
              'OBSERVER_ISOLATED_OK',
              'holo observer callback.failed',
              'holo observer callback.timeout',
              'holo observer event.dropped'
            ]
              .every(marker => nativeLogContains(page, marker)),
          'real Guest success and fixed observer diagnostics'
        )
        assert(!JSON.stringify(logs).includes('private observer throw marker'))
        assert(!JSON.stringify(logs).includes(privateMarker))
        assert(!nativeLogContains(logs, 'private observer throw marker'))
        assert(!nativeLogContains(logs, privateMarker))
        assert.equal((await f.client.getProcess(id)).state, 'running')
      })
    },
    25_000
  )

  it.skipIf(process.platform !== 'darwin')(
    'disposes old callback ownership across plugin revision, stop and restart',
    async () => {
      await withService({
        events: ['script.compiled'],
        plugin: revisionPlugin,
        pluginConfig: {
          newSha: digest('21*2'),
          oldSha: digest('40+2'),
          probeSha: digest('6*7'),
          tag: 'A',
          watchOrigin: 'app://workspace/revision.cjs'
        }
      }, async (f, url) => {
        await writeFile(join(f.project, 'dep2.cjs'), 'exports.value = 42\n')
        await writeFile(
          join(f.project, 'revision.cjs'),
          `
        let old = false, probe = false, fresh = false;
        setInterval(() => {
          if (!old) try { if (eval('40+2') === 42) { old = true; console.log('OBSERVER_A_READY') } } catch {}
          if (!probe) try { if (eval('6*7') === 42) { require('./dep2.cjs'); probe = true } } catch {}
          if (probe && !fresh) try {
            if (eval('21*2') === 42) { fresh = true; console.log('OBSERVER_B_READY') }
          } catch {}
        }, 10);
      `
        )
        const result = await finish(startCli(f, url, 'run', './revision.cjs', ['--detach']))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        await logsUntil(f, id, 'OBSERVER_A_READY', 1)
        const active = await f.client.getProcess(id)
        assert.equal(active.pluginGraphRevision, 1)
        // A's callback is still pending. Replacing its graph disposes that subscription;
        // B must observe its own later dep2 compilation before it can acknowledge readiness.
        const configPath = join(f.project, 'holo.config.json')
        await writeFile(
          configPath,
          JSON.stringify({
            plugins: [{
              config: {
                newSha: digest('21*2'),
                oldSha: digest('40+2'),
                probeSha: digest('6*7'),
                tag: 'B',
                watchOrigin: 'app://workspace/dep2.cjs'
              },
              id: 'observer',
              use: './observer.mjs'
            }]
          })
        )
        const candidate = prepareHolonomyRuntimePlugins(configPath).bundles
        const changed = await f.client.replaceRuntimePlugins(
          id,
          { expectedGeneration: 1, runtimePlugins: candidate },
          1,
          randomUUID()
        )
        const update = await until(
          () => f.client.getOperation(changed.value.operation.id),
          op => ['succeeded', 'failed'].includes(op.state),
          'observer plugin revision'
        )
        assert.equal(update.state, 'succeeded', JSON.stringify(update))
        assert.equal((await f.client.getProcess(id)).pluginGraphRevision, 2)
        await logsUntil(f, id, 'OBSERVER_B_READY', 1)
        const stopped = await f.client.processAction(id, 'stop', 1, randomUUID())
        await until(() => f.client.getOperation(stopped.value.operation.id), op => op.state === 'succeeded', 'stop')
        const restarted = await f.client.processAction(id, 'restart', 1, randomUUID())
        await until(
          () => f.client.getOperation(restarted.value.operation.id),
          op => op.state === 'succeeded',
          'restart'
        )
        const latest = await logsUntil(f, id, 'OBSERVER_B_READY', 2)
        assert(
          !nativeLogContains(latest, 'OBSERVER_A_READY', 2)
        )
        assert.equal((await f.client.getProcess(id)).generation, 2)
        assert.equal((await f.client.getProcess(id)).pluginGraphRevision, 2)
      })
    },
    30_000
  )
})
