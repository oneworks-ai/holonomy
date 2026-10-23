/* eslint-disable max-lines -- One real CLI, Service and Native fixture covers installation and lifecycle. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

import { createHolonomyServiceLifecycleManager } from '../lifecycle-manager.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const absent = binary == null || process.platform !== 'darwin'
const cli = fileURLToPath(new URL('../../holonomy.mjs', import.meta.url))
const privateSource = 'OBSERVER_PROFILE_PRIVATE_SOURCE_SENTINEL'
const privateConfig = 'OBSERVER_PROFILE_PRIVATE_CONFIG_SENTINEL'
const blockedSource = 'OBSERVER_PROFILE_BLOCKED_SOURCE_SENTINEL'
const privateHelper = 'OBSERVER_PROFILE_PRIVATE_HELPER_SENTINEL'
const entryMarker = 'OBSERVER_PROFILE_GUEST_ENTRY'
const terminalStates = new Set(['cancelled', 'exited', 'failed', 'lost'])
const registration = {
  acceptHighCost: true,
  callbackTimeoutMs: 100,
  events: ['script.compiled'],
  maxQueuedEvents: 16
}
const profileSource = `
const privateValue = '${privateSource}';
export default (event, config, sink) => {
  if (event.event === 'script.compiled' && config.marker === '${privateConfig}' && privateValue)
    sink.publish();
};`
const blockingProfileSource = `
const privateValue = '${blockedSource}';
export default () => { if (privateValue) for (;;) {} };
`
const importedProfileSource = `
import { helper } from './helper.mjs';
const privateValue = '${privateSource}';
export default (event, config, sink) => {
  if (helper && privateValue && config.marker === '${privateConfig}') sink.publish();
};`
const gateSource = `export default ctx => {
  ctx.holo.engineGate(() => ({ action: 'allow' }));
};`
const guestCjsTest = withGate => `
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const flag = async name => {
  for (let attempt = 0; attempt < 1500; attempt++) {
    try { if (readFileSync('holo-fs://workspace/' + name + '.txt', 'utf8') === 'go') return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Host fixture did not release ' + name);
};
test('Native profile with real Node APIs', async () => {
  console.log('OBSERVER_PROFILE_TEST_WAITING');
  console.log('OBSERVER_PROFILE_TEST_READY');
  await flag('compile');
  assert.equal(require('./dep.cjs').value, 42);
  ${withGate ? "assert.equal(eval('40+2'), 42);" : ''}
  console.log('OBSERVER_PROFILE_TEST_PROGRESS');
  console.log('OBSERVER_PROFILE_TEST_AFTER_PROGRESS');
  await flag('finish');
});`

const policy = (events = ['script.compiled'], maxObserverCallbackMs = 1000) => ({
  codeGeneration: {
    dynamicImport: { access: 'none' },
    strings: { access: 'controlled', decisionTimeoutMs: 1000, maxOperations: 128, maxSourceBytes: 1024 },
    wasm: { access: 'none' }
  },
  diagnostics: {
    maxObserverCallbackMs,
    maxQueuedEvents: 32,
    maxSourceReadBytes: 0,
    observerEvents: events,
    retentionMs: 0,
    sourceReader: 'none'
  },
  filesystem: {
    access: 'sandboxed',
    limits: {
      maxDirectoryEntries: 32,
      maxOpenHandles: 8,
      maxQueuedEvents: 0,
      maxReadBytes: 4096,
      maxWatchers: 0,
      maxWriteBytes: 4096
    },
    roots: [{
      rights: ['read', 'write'],
      rootId: 'workspace',
      symlinks: 'deny',
      virtualUrl: 'holo-fs://workspace/'
    }]
  },
  schemaVersion: 2
})

const manifest = (profiles = {
  monitor: {
    config: { marker: privateConfig },
    registration,
    sink: { maxBytes: 1024 * 1024 },
    use: './observer-source/monitor.mjs'
  }
}) => ({ pluginRoots: [], profiles, schemaVersion: 1 })

const fixture = async (
  {
    installed = true,
    initialObserverIds = ['monitor'],
    observerRegistry,
    source = profileSource,
    blockingProfile = false,
    helperSource,
    nestedHome = false,
    selectedPolicy = policy()
  } = {}
) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-service-observer-profile-')))
  const project = join(root, 'project')
  const home = nestedHome ? join(project, 'private', 'service') : join(root, 'home')
  try {
    await mkdir(project, { mode: 0o700 })
    await mkdir(home, { mode: 0o700, recursive: true })
    await mkdir(join(home, 'observer-source'), { mode: 0o700 })
    await writeFile(
      join(home, 'native-runtime.json'),
      JSON.stringify({
        executablePath: await realpath(binary),
        schemaVersion: 1
      }),
      { mode: 0o600 }
    )
    await writeFile(join(home, 'observer-source', 'monitor.mjs'), source, { mode: 0o600 })
    if (helperSource != null) {
      await writeFile(join(home, 'observer-source', 'helper.mjs'), helperSource, { mode: 0o600 })
    }
    if (blockingProfile) {
      await writeFile(join(home, 'observer-source', 'blocked.mjs'), blockingProfileSource, { mode: 0o600 })
    }
    if (installed) {
      const profiles = manifest().profiles
      if (blockingProfile) {
        profiles.blocked = {
          registration: { ...registration, callbackTimeoutMs: 50, maxQueuedEvents: 1 },
          sink: { maxBytes: 1024 * 1024 },
          use: './observer-source/blocked.mjs'
        }
      }
      await writeFile(join(home, 'native-observer-profiles.json'), JSON.stringify(manifest(profiles)), { mode: 0o600 })
    }
    await writeFile(join(project, 'gate.mjs'), gateSource)
    await writeFile(
      join(project, 'holo.config.json'),
      JSON.stringify({
        plugins: [{ id: 'gate', use: './gate.mjs' }]
      })
    )
    await writeFile(
      join(project, 'capability.json'),
      JSON.stringify({
        context: {
          guest: { application: { id: 'native.observer.profile', name: 'Native observer profile' } },
          host: { tenantId: privateConfig },
          schemaVersion: 1
        },
        initialMiddlewareId: 'service.continue.v1',
        initialObserverIds,
        sandboxPolicy: selectedPolicy,
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

const waitFor = async (read, accepts, label, deadlineMs = 12_000) => {
  const deadline = Date.now() + deadlineMs
  let latest
  while (Date.now() < deadline) {
    latest = await read()
    if (accepts(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`${label} did not settle: ${JSON.stringify(latest)}`)
}

const cliRun = (f, url, command, entry, flags = [], withConfig = true) => {
  const child = spawn(process.execPath, [
    cli,
    command,
    entry,
    '--target',
    'native',
    ...(withConfig ? ['--config', 'holo.config.json'] : []),
    '--capability-runtime',
    'capability.json',
    '--openapi',
    `${url}/openapi.json`,
    '--openapi-token-file',
    join(f.home, 'token'),
    ...flags
  ], { cwd: f.project, env: { ...process.env, HOLONOMY_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = { stderr: '', stdout: '' }
  child.stdout.on('data', bytes => output.stdout += bytes)
  child.stderr.on('data', bytes => output.stderr += bytes)
  const completed = once(child, 'close')
  void completed.catch(() => undefined)
  return { child, completed, output }
}

const finishedCli = async (running, deadlineMs = 15_000) => {
  const timeout = setTimeout(() => running.child.kill('SIGKILL'), deadlineMs)
  try {
    const [code, signal] = await running.completed
    return { code, signal, ...running.output }
  } finally {
    clearTimeout(timeout)
  }
}

const processList = f => f.client.call('/v1/processes')
const firstProcess = (f, running) =>
  waitFor(async () => {
    const list = await processList(f)
    if (list.length === 0 && (running.child.exitCode != null || running.child.signalCode != null)) {
      assert.fail(`CLI exited before Service process admission: ${JSON.stringify(running.output)}`)
    }
    return list
  }, list =>
    list.length > 0, 'Service process admission')
const logsWith = async (f, id, marker, generation = 1) => {
  try {
    return await waitFor(
      () => f.client.readLogs(id, { after: 0, limit: 512 }),
      page => page.events.some(event => event.generation === generation && event.chunk.includes(marker)),
      `Guest ${marker} log in generation ${generation}`
    )
  } catch (error) {
    const state = await f.client.getProcess(id).catch(() => undefined)
    error.message += `; process=${JSON.stringify(state)}`
    throw error
  }
}
const cliWith = (running, marker) =>
  waitFor(() => running.output, output => output.stdout.includes(marker), `CLI-followed ${marker}`)
const operation = (f, id) =>
  waitFor(
    () => f.client.getOperation(id),
    value => ['succeeded', 'failed', 'cancelled'].includes(value.state),
    'Service operation'
  )
const terminal = (f, id) =>
  waitFor(
    () => f.client.getProcess(id),
    value => terminalStates.has(value.state) && value.cleanupPending !== true,
    'Native terminal'
  )
const remove = async (f, id) => {
  const current = await f.client.getProcess(id)
  if (!terminalStates.has(current.state)) {
    const stopped = await f.client.processAction(id, 'stop', current.generation, randomUUID())
    assert.equal((await operation(f, stopped.value.operation.id)).state, 'succeeded')
  }
  const ended = await terminal(f, id)
  await f.client.removeProcess(id, ended.generation, randomUUID())
}
const withService = async (options, body) => {
  const f = await fixture(options)
  let started
  try {
    started = await f.manager.ensure()
    return await body(f, started.endpoint.baseUrl)
  } finally {
    try {
      if (started != null) {
        for (const process of await processList(f)) await remove(f, process.id)
      }
    } finally {
      try {
        if (started != null) await f.manager.stop({ drain: true })
      } finally {
        await rm(f.root, { force: true, recursive: true })
      }
    }
  }
}

// Only the test driver opens its own Service-private generation path. Neither
// the CLI request nor the Guest graph receives this path or its contents.
const generationRoot = (f, id, generation) => join(f.home, 'state', 'native-processes', id, `g${generation}`)
const receiptPath = (f, id, generation, profile = 'monitor') =>
  join(generationRoot(f, id, generation), 'host', 'observer-output', `${profile}.jsonl`)
const receipts = async (f, id, generation, profile = 'monitor') => {
  let text
  try {
    text = await readFile(receiptPath(f, id, generation, profile), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const lines = text.split('\n')
  if (lines.at(-1) !== '') lines.pop() // The writer may be appending a line.
  return lines.filter(Boolean).map(line => JSON.parse(line))
}
const compiledReceipt = (f, id, generation) =>
  waitFor(
    () => receipts(f, id, generation),
    rows => rows.some(row => row.status === 'event' && row.sourceEvent?.event === 'script.compiled'),
    `private Native Observer receipt in generation ${generation}`
  )
const assertPublicRedacted = (f, ...values) => {
  const encoded = JSON.stringify(values)
  for (
    const value of [
      privateSource,
      privateConfig,
      blockedSource,
      privateHelper,
      'observer-source/monitor.mjs',
      'observer-source/blocked.mjs',
      'observer-source/helper.mjs',
      'observer-output/monitor.jsonl',
      'observer-output/blocked.jsonl',
      f.root
    ]
  ) assert(!encoded.includes(value), value)
}

describe('public CLI -> Service owner registry -> isolated Native Observer profile', () => {
  it.skipIf(absent)(
    'runs real Guest node:test with private metadata receipts, FS latches and an independent Engine Gate',
    async () =>
      withService({}, async (f, url) => {
        await writeFile(join(f.project, 'dep.cjs'), 'exports.value = 42')
        await writeFile(join(f.project, 'profile.test.cjs'), guestCjsTest(true))
        const running = cliRun(f, url, 'test', './profile.test.cjs', ['--reporter', 'json'])
        try {
          const [selected] = await firstProcess(f, running)
          const id = selected.id
          await logsWith(f, id, 'OBSERVER_PROFILE_TEST_WAITING')
          const workspace = join(f.home, 'state', 'native-processes', id, 'workspace')
          await writeFile(join(workspace, 'compile.txt'), 'go')
          await logsWith(f, id, 'OBSERVER_PROFILE_TEST_PROGRESS')
          const observed = await waitFor(
            () => receipts(f, id, 1),
            rows =>
              rows.some(row =>
                row.status === 'event' &&
                row.sourceEvent?.payload?.origin === 'app://workspace/dep.cjs'
              ),
            'private Native Observer lazy CJS receipt'
          )
          const receipt = observed.find(row =>
            row.status === 'event' &&
            row.sourceEvent?.payload?.origin === 'app://workspace/dep.cjs'
          )
          assert(receipt, JSON.stringify(observed))
          assert.equal(receipt.profileId, 'monitor')
          assert.match(receipt.sessionId, /^[a-f\d]{32}$/u)
          assert.match(receipt.sourceEvent.payload.sourceSha256, /^[a-f\d]{64}$/u)
          assert.equal(receipt.sourceEvent.payload.source == null, true)
          assert.equal((await stat(receiptPath(f, id, 1))).mode & 0o777, 0o600)
          assertPublicRedacted(f, observed, await f.client.getProcess(id), await processList(f))
          await writeFile(join(workspace, 'finish.txt'), 'go')
          const result = await finishedCli(running)
          assert.equal(result.code, 0, result.stderr + result.stdout)
          const report = result.stdout.split('\n').map(line => {
            try {
              return JSON.parse(line)
            } catch {
              return null
            }
          }).find(value => value?.total === 1 && Array.isArray(value.results))
          assert(report, result.stdout)
          assert.equal(report.passed, 1)
          const ended = await terminal(f, id)
          assert.equal(ended.exit?.code, 0, JSON.stringify(ended))
          assertPublicRedacted(f, result, ended, await f.client.readLogs(id, { after: 0, limit: 512 }))
        } finally {
          running.child.kill('SIGKILL')
        }
      }),
    35_000
  )

  it.skipIf(absent)(
    'keeps Guest FS and Engine Gate live while a separate profile loops synchronously',
    async () =>
      withService({ blockingProfile: true, initialObserverIds: ['blocked', 'monitor'] }, async (f, url) => {
        await writeFile(
          join(f.project, 'entry.mjs'),
          `
        import { readFileSync } from 'node:fs';
        console.log('${entryMarker}');
        let released = false;
        setInterval(() => {
          if (released) return;
          try {
            if (readFileSync('holo-fs://workspace/gate.txt', 'utf8') !== 'go') return;
            released = true;
            if (eval('40+2') !== 42) throw Error('Engine Gate failed');
            console.log('OBSERVER_PROFILE_LOOP_GATE_PROGRESS');
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }, 20);
      `
        )
        const result = await finishedCli(cliRun(f, url, 'run', './entry.mjs', ['--detach']))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        await logsWith(f, id, entryMarker)
        const healthy = await compiledReceipt(f, id, 1)
        const blocked = await waitFor(
          () => receipts(f, id, 1, 'blocked'),
          rows => rows.some(row => row.status === 'callback.timeout'),
          'isolated synchronous Observer timeout'
        )
        assert.equal(blocked.find(row => row.status === 'callback.timeout').profileId, 'blocked')
        await writeFile(join(f.home, 'state', 'native-processes', id, 'workspace', 'gate.txt'), 'go')
        await logsWith(f, id, 'OBSERVER_PROFILE_LOOP_GATE_PROGRESS')
        assert.equal((await f.client.getProcess(id)).state, 'running')
        assertPublicRedacted(
          f,
          healthy,
          blocked,
          await f.client.getProcess(id),
          await f.client.readLogs(id, { after: 0, limit: 512 })
        )
      }),
    30_000
  )

  it.skipIf(absent)(
    'runs profile-only Native node:test without an ordinary plugin config',
    async () =>
      withService({}, async (f, url) => {
        await writeFile(join(f.project, 'dep.cjs'), 'exports.value = 42')
        await writeFile(join(f.project, 'profile.test.cjs'), guestCjsTest(false))
        const running = cliRun(f, url, 'test', './profile.test.cjs', ['--reporter', 'json'], false)
        const [selected] = await firstProcess(f, running)
        const id = selected.id
        await logsWith(f, id, 'OBSERVER_PROFILE_TEST_WAITING')
        const workspace = join(f.home, 'state', 'native-processes', id, 'workspace')
        await writeFile(join(workspace, 'compile.txt'), 'go')
        await logsWith(f, id, 'OBSERVER_PROFILE_TEST_PROGRESS')
        const observed = await waitFor(
          () => receipts(f, id, 1),
          rows =>
            rows.some(row =>
              row.status === 'event' &&
              row.sourceEvent?.payload?.origin === 'app://workspace/dep.cjs'
            ),
          'profile-only Native lazy CJS receipt'
        )
        await writeFile(join(workspace, 'finish.txt'), 'go')
        const result = await finishedCli(running)
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const report = result.stdout.split('\n').map(line => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        }).find(value => value?.total === 1 && Array.isArray(value.results))
        assert(report, result.stdout)
        assert.equal(report.passed, 1)
        assert(result.stdout.includes('OBSERVER_PROFILE_TEST_PROGRESS'), result.stdout)
        assert.equal((await terminal(f, id)).exit?.code, 0)
        assertPublicRedacted(f, result, observed, await f.client.getProcess(id))
      }),
    25_000
  )

  it.skipIf(absent)(
    'rejects absent and wrong Native IDs despite a same-name Node callback before Guest entry',
    async () => {
      for (
        const options of [
          { installed: false, initialObserverIds: ['monitor'] },
          { initialObserverIds: ['missing'] },
          {
            installed: false,
            initialObserverIds: ['node.same-name'],
            observerRegistry: {
              'node.same-name': { observer: () => undefined, registration: { events: ['script.compiled'] } }
            }
          }
        ]
      ) {
        await withService(options, async (f, url) => {
          await writeFile(join(f.project, 'entry.mjs'), `console.log('${entryMarker}')`)
          const result = await finishedCli(cliRun(f, url, 'run', './entry.mjs', ['--detach']))
          assert.equal(result.code, 1, result.stderr + result.stdout)
          assert(!result.stdout.includes(entryMarker))
          assert(!result.stderr.includes(entryMarker))
          assert.deepEqual(await processList(f), [])
          assertPublicRedacted(f, result)
        })
      }
    },
    30_000
  )

  it.skipIf(absent)(
    'leaves an installed but unselected profile inactive',
    async () =>
      withService({ initialObserverIds: [] }, async (f, url) => {
        await writeFile(join(f.project, 'entry.mjs'), `console.log('${entryMarker}')`)
        const result = await finishedCli(cliRun(f, url, 'run', './entry.mjs', ['--detach']))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        await logsWith(f, id, entryMarker)
        assert.equal((await terminal(f, id)).exit?.code, 0)
        await assert.rejects(stat(receiptPath(f, id, 1)), { code: 'ENOENT' })
        assertPublicRedacted(f, result, await f.client.getProcess(id))
      }),
    20_000
  )

  it.skipIf(absent)(
    'uses a new private sink session after Service stop and Native restart',
    async () =>
      withService({}, async (f, url) => {
        await writeFile(
          join(f.project, 'entry.mjs'),
          `
        console.log('${entryMarker}');
        setInterval(() => {}, 1000);
      `
        )
        const result = await finishedCli(cliRun(f, url, 'run', './entry.mjs', ['--detach']))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        await logsWith(f, id, entryMarker)
        const first = await compiledReceipt(f, id, 1)
        const session1 = first.find(row => row.status === 'event').sessionId
        const stopped = await f.client.processAction(id, 'stop', 1, randomUUID())
        assert.equal((await operation(f, stopped.value.operation.id)).state, 'succeeded')
        await terminal(f, id)
        const restarted = await f.client.processAction(id, 'restart', 1, randomUUID())
        assert.equal((await operation(f, restarted.value.operation.id)).state, 'succeeded')
        await logsWith(f, id, entryMarker, 2)
        const second = await compiledReceipt(f, id, 2)
        const session2 = second.find(row => row.status === 'event').sessionId
        assert.notEqual(session2, session1)
        assert.equal((await f.client.getProcess(id)).generation, 2)
        assertPublicRedacted(f, await f.client.getProcess(id), await f.client.readLogs(id, { after: 0, limit: 512 }))
      }),
    30_000
  )

  it.skipIf(absent)(
    'keeps a selected private profile across ordinary plugin watch revisions',
    async () =>
      withService({}, async (f, url) => {
        await writeFile(join(f.project, 'dep.cjs'), 'exports.value = 42')
        await writeFile(
          join(f.project, 'entry.cjs'),
          `
        const { readFileSync } = require('node:fs');
        console.log('${entryMarker}');
        let released = false;
        setInterval(() => {
          if (released) return;
          try {
            if (readFileSync('holo-fs://workspace/watch.txt', 'utf8') !== 'go') return;
            released = true;
            if (require('./dep.cjs').value !== 42) throw Error('Lazy CJS compile failed');
            if (eval('40+2') !== 42) throw Error('Engine Gate did not progress');
            console.log('OBSERVER_PROFILE_WATCH_PROGRESS');
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }, 20);
      `
        )
        const running = cliRun(f, url, 'run', './entry.cjs', ['--watch'])
        try {
          const [selected] = await firstProcess(f, running)
          const id = selected.id
          await cliWith(running, entryMarker)
          const before = await compiledReceipt(f, id, 1)
          const session = before.find(row => row.status === 'event').sessionId
          await writeFile(
            join(f.project, 'holo.config.json'),
            JSON.stringify({
              plugins: [{ config: { revision: 2 }, id: 'gate', use: './gate.mjs' }]
            })
          )
          await waitFor(
            () => f.client.getProcess(id),
            value => value.pluginGraphRevision >= 2,
            `ordinary plugin watch revision; CLI: ${JSON.stringify(running.output)}`
          )
          await writeFile(join(f.home, 'state', 'native-processes', id, 'workspace', 'watch.txt'), 'go')
          await logsWith(f, id, 'OBSERVER_PROFILE_WATCH_PROGRESS')
          const after = await waitFor(
            () => receipts(f, id, 1),
            rows =>
              rows.some(row =>
                row.status === 'event' &&
                row.sourceEvent?.payload?.origin === 'app://workspace/dep.cjs'
              ),
            'post-watch private observer receipt'
          )
          assert(after.every(row => row.sessionId === session))
          assertPublicRedacted(f, await f.client.getProcess(id), await f.client.readLogs(id, { after: 0, limit: 512 }))
        } finally {
          running.child.kill('SIGKILL')
          await running.completed
        }
      }),
    35_000
  )

  it.skipIf(absent)(
    'keeps nested owner source and its relative helper out of Guest source collection, including hardlinks',
    async () =>
      withService({
        helperSource: `export const helper = '${privateHelper}';`,
        nestedHome: true,
        source: importedProfileSource
      }, async (f, url) => {
        const entry = join(f.project, 'entry.mjs')
        await writeFile(entry, `console.log('${entryMarker}')`)
        const safe = await finishedCli(cliRun(f, url, 'run', './entry.mjs', ['--detach']))
        assert.equal(safe.code, 0, safe.stderr + safe.stdout)
        const safeId = JSON.parse(safe.stdout).processId
        await logsWith(f, safeId, entryMarker)
        await terminal(f, safeId)
        await remove(f, safeId)

        const assertDeniedSource = async specifier => {
          await writeFile(entry, `import ${JSON.stringify(specifier)}; console.log('${entryMarker}')`)
          const denied = await finishedCli(cliRun(f, url, 'run', './entry.mjs', ['--detach']))
          assert.equal(denied.code, 1, denied.stderr + denied.stdout)
          assert(!denied.stdout.includes(entryMarker))
          assert(!denied.stderr.includes(entryMarker))
          assert.deepEqual(await processList(f), [])
          assertPublicRedacted(f, denied)
        }
        await assertDeniedSource('./private/service/observer-source/monitor.mjs')
        const alias = join(f.project, 'guest-alias')
        await mkdir(alias)
        await link(join(f.home, 'observer-source', 'monitor.mjs'), join(alias, 'monitor.mjs'))
        await link(join(f.home, 'observer-source', 'helper.mjs'), join(alias, 'helper.mjs'))
        await assertDeniedSource('./guest-alias/monitor.mjs')
      }),
    35_000
  )

  it.skipIf(absent)(
    'rejects owner file permissions and invalid profile Schema before starting Guest',
    async () => {
      const denied = await fixture({})
      try {
        await chmod(join(denied.home, 'native-observer-profiles.json'), 0o644)
        await assert.rejects(denied.manager.ensure())
      } finally {
        await denied.manager.stop({ drain: true }).catch(() => undefined)
        await rm(denied.root, { force: true, recursive: true })
      }
      const invalid = await fixture({})
      try {
        const sourceRoot = join(invalid.home, 'observer-source')
        await writeFile(
          join(sourceRoot, 'package.json'),
          JSON.stringify({
            type: 'module',
            holo: { apiVersion: 1, configSchema: './schema.json', entry: './monitor.mjs', kind: 'runtime-plugin' }
          })
        )
        await writeFile(
          join(sourceRoot, 'schema.json'),
          JSON.stringify({
            additionalProperties: false,
            properties: { allowed: { type: 'boolean' } },
            type: 'object'
          })
        )
        await writeFile(
          join(invalid.home, 'native-observer-profiles.json'),
          JSON.stringify(manifest({
            monitor: { config: { denied: true }, registration, use: './observer-source/package.json' }
          })),
          { mode: 0o600 }
        )
        await assert.rejects(invalid.manager.ensure())
      } finally {
        await invalid.manager.stop({ drain: true }).catch(() => undefined)
        await rm(invalid.root, { force: true, recursive: true })
      }
    },
    20_000
  )
})
