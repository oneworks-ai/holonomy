/* eslint-disable max-lines -- Public Native source reader and audit journeys share one executable fixture. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

import { createHolonomyServiceLifecycleManager } from '../lifecycle-manager.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const absent = binary == null || process.platform !== 'darwin'
const cli = fileURLToPath(new URL('../../holonomy.mjs', import.meta.url))
const privateMarker = 'HOST_READER_PRIVATE_SOURCE_SENTINEL'
const guestMarker = 'GUEST_READER_RAW_SOURCE_SENTINEL'
const readerInstallation = Object.freeze({
  capabilityName: 'host.diagnostics.source.read',
  maxReadBytes: 6,
  maxReads: 3
})
const controlled = (maxOperations, decisionTimeoutMs = 4_000) => ({
  access: 'controlled',
  decisionTimeoutMs,
  maxOperations,
  maxSourceBytes: 4_096
})
const policy = (reader = 'boundedSource', mode = 'bounded') => ({
  codeGeneration: {
    dynamicImport: controlled(1),
    strings: controlled(mode === 'capacity' ? 32 : 2, mode === 'late' ? 250 : 4_000),
    wasm: controlled(1)
  },
  diagnostics: {
    maxObserverCallbackMs: 1,
    maxQueuedEvents: 0,
    maxSourceReadBytes: reader === 'boundedSource' ? 5 : 0,
    observerEvents: [],
    retentionMs: 0,
    sourceReader: reader
  },
  schemaVersion: 2
})
const pluginSource = `
const privateSource = '${privateMarker}';
const unavailable = error => String(error).includes('engine_source_reader_unavailable');
export default (ctx, config) => {
  void privateSource;
  let calls = 0;
  let previousReader;
  let previousSignal;
  let previousCopy;
  let latePending = false;
  ctx.holo.engineGate(async request => {
    calls += 1;
    if (config.mode === 'metadata') {
      return request.sourceReader == null && !('sourceReader' in request)
        ? { action: 'allow' }
        : { action: 'deny', reasonCode: 'host.unexpected_reader' };
    }
    if (config.mode === 'capacity' || config.mode === 'watch' || config.mode === 'watch2') {
      if (request.operation !== 'runtime.code.generate.strings' || request.sourceReader == null)
        return { action: 'deny', reasonCode: 'host.audit_reader_missing' };
      try {
        const copy = await request.sourceReader.read({ maxBytes: 64 });
        return JSON.stringify(Array.from(copy)) === JSON.stringify([52, 48, 43, 50])
          ? { action: 'allow' }
          : { action: 'deny', reasonCode: 'host.audit_wrong_source' };
      } catch (error) {
        return { action: 'deny', reasonCode: unavailable(error)
          ? 'host.audit_full' : 'host.audit_read_error' };
      }
    }
    if (config.mode === 'late') {
      if (request.operation !== 'runtime.code.generate.strings' || request.sourceReader == null)
        return { action: 'deny', reasonCode: 'host.late_missing_reader' };
      if (calls === 1) {
        const copy = await request.sourceReader.read({ maxBytes: 64 });
        if (JSON.stringify(Array.from(copy)) !== JSON.stringify([52, 48, 43, 50]))
          return { action: 'deny', reasonCode: 'host.late_wrong_source' };
        previousReader = request.sourceReader;
        previousSignal = request.signal;
        previousCopy = copy;
        latePending = true;
        await new Promise(resolve => setTimeout(resolve, 2000));
        latePending = false;
        return { action: 'allow' };
      }
      if (calls !== 2 || !latePending || !previousSignal.aborted ||
          Array.from(previousCopy).some(byte => byte !== 0))
        return { action: 'deny', reasonCode: 'host.late_cancel_missing' };
      try {
        await previousReader.read({ maxBytes: 1 });
        return { action: 'deny', reasonCode: 'host.late_old_reader_open' };
      } catch (error) {
        if (!unavailable(error))
          return { action: 'deny', reasonCode: 'host.late_wrong_reader_error' };
      }
      const fresh = await request.sourceReader.read({ maxBytes: 64 });
      return JSON.stringify(Array.from(fresh)) === JSON.stringify([54, 42, 55])
        ? { action: 'allow' }
        : { action: 'deny', reasonCode: 'host.late_new_reader_wrong' };
    }
    const expected = [
      ['runtime.code.generate.strings', [52, 48, 43, 50]],
      ['runtime.code.generate.wasm', [0, 97, 115, 109, 1]],
      ['runtime.module.import', [101, 120, 112, 111, 114]],
      ['runtime.code.generate.strings', null]
    ][calls - 1];
    if (expected == null || request.operation !== expected[0])
      return { action: 'deny', reasonCode: 'host.unexpected_operation' };
    if (expected[1] == null) {
      return request.sourceReader == null && !('sourceReader' in request)
        ? { action: 'allow' }
        : { action: 'deny', reasonCode: 'host.read_budget_escaped' };
    }
    if (request.sourceReader == null)
      return { action: 'deny', reasonCode: 'host.reader_missing' };
    const prefix = Array.from(await request.sourceReader.read({ maxBytes: 64 }));
    if (JSON.stringify(prefix) !== JSON.stringify(expected[1]))
      return { action: 'deny', reasonCode: 'host.wrong_source_prefix' };
    try {
      await request.sourceReader.read({ maxBytes: 1 });
      return { action: 'deny', reasonCode: 'host.reader_reused' };
    } catch (error) {
      return unavailable(error)
        ? { action: 'allow' }
        : { action: 'deny', reasonCode: 'host.wrong_reader_error' };
    }
  });
};`
const guestSource = `
import assert from 'node:assert/strict';
const raw = '40+2'; // ${guestMarker}
assert.equal(eval(raw), 42);
const wasm = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
assert.ok(await WebAssembly.compile(wasm) instanceof WebAssembly.Module);
assert.equal((await import('./lazy.mjs')).value, 42);
assert.equal(eval('6*7'), 42);
assert.equal(typeof globalThis.sourceReader, 'undefined');
assert.equal(typeof globalThis.privateSource, 'undefined');
console.log('NATIVE_SOURCE_READER_GUEST_OK');`

const fixture = async ({ installed = true, mode = 'bounded', reader = 'boundedSource', auditBytes } = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-managed-source-reader-')))
  const home = join(root, 'home')
  const project = join(root, 'project')
  try {
    await mkdir(home)
    await mkdir(project)
    await writeFile(
      join(home, 'native-runtime.json'),
      JSON.stringify({
        executablePath: binary,
        ...(installed ? { diagnosticSourceReader: readerInstallation } : {}),
        ...(auditBytes == null ? {} : { diagnosticAudit: { maxBytes: auditBytes } }),
        schemaVersion: 1
      }),
      { mode: 0o600 }
    )
    await writeFile(join(project, 'gate.mjs'), pluginSource)
    await writeFile(join(project, 'lazy.mjs'), 'export const value = 42;')
    await writeFile(join(project, 'index.mjs'), guestSource)
    await writeFile(
      join(project, 'holo.config.json'),
      JSON.stringify({ plugins: [{ config: { mode }, id: 'source-reader', use: './gate.mjs' }] })
    )
    await writeFile(
      join(project, 'capability.json'),
      JSON.stringify({
        context: {
          guest: { application: { id: 'native.source.reader', name: 'Native source reader' } },
          host: { tenantId: privateMarker },
          schemaVersion: 1
        },
        initialMiddlewareId: 'service.continue.v1',
        sandboxPolicy: policy(reader, mode),
        schemaVersion: 1
      })
    )
    const client = new HolonomyServiceClient({ home, environment: {} })
    const manager = createHolonomyServiceLifecycleManager({ client, home, service: { port: 0 } })
    return { client, home, manager, project, root }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

const start = (f, url, entry = './index.mjs', { command = 'run', withConfig = true, extra = [] } = {}) => {
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
    ...extra,
    ...(command === 'run' && !extra.includes('--watch') ? ['--detach'] : [])
  ], { cwd: f.project, env: { ...process.env, HOLONOMY_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', bytes => output.stdout += bytes)
  child.stderr.on('data', bytes => output.stderr += bytes)
  return { child, completed: once(child, 'close'), output }
}
const finish = async (running, timeoutMs = 15_000) => {
  const timer = setTimeout(() => running.child.kill('SIGKILL'), timeoutMs)
  try {
    const [code] = await running.completed
    return { code, ...running.output }
  } finally {
    clearTimeout(timer)
  }
}
const until = async (read, accepts, label) => {
  let latest
  for (let turn = 0; turn < 700; turn++) {
    latest = await read()
    if (accepts(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`${label} did not settle: ${JSON.stringify(latest)}`)
}
const terminalStates = new Set(['cancelled', 'exited', 'failed', 'lost'])
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
  const owned = new Set()
  let running
  try {
    running = await f.manager.ensure()
    return await body(f, running.endpoint.baseUrl, owned)
  } finally {
    try {
      for (const id of owned) await remove(f, id)
    } finally {
      try {
        if (running != null) await f.manager.stop({ drain: true })
      } finally {
        await rm(f.root, { recursive: true, force: true })
      }
    }
  }
}
const assertPrivate = value => {
  const serialized = JSON.stringify(value)
  assert(!serialized.includes(privateMarker), serialized)
  assert(!serialized.includes(guestMarker), serialized)
  assert(!serialized.includes('diagnosticSourceReader'), serialized)
  assert(!serialized.includes('diagnosticAudit'), serialized)
  assert(!serialized.includes('source-reads.jsonl'), serialized)
  assert(!serialized.includes('host.diagnostics.source.read'), serialized)
}

const auditPath = (f, id, generation = 1) =>
  join(f.home, 'state', 'native-processes', id, `g${generation}`, 'host', 'audit', 'source-reads.jsonl')

const readAudit = async (f, id, generation = 1) => {
  const text = await readFile(auditPath(f, id, generation), 'utf8')
  assert(text === '' || text.endsWith('\n'))
  return text.trimEnd() === '' ? [] : text.trimEnd().split('\n').map(line => JSON.parse(line))
}

describe('native Host-only source reader through public entrypoints', () => {
  it.skipIf(absent)('reads exact bounded string, Wasm and dynamic-module bytes in standalone holo', async () => {
    const f = await fixture()
    try {
      await writeFile(
        join(f.project, 'host.json'),
        JSON.stringify({
          diagnosticSourceReader: readerInstallation,
          plugins: [{ config: { mode: 'bounded' }, id: 'source-reader', use: './gate.mjs' }],
          sandboxPolicy: policy(),
          schemaVersion: 1
        })
      )
      const child = spawn(binary, ['--timeout', '10000', '--host-config', 'host.json', './index.mjs'], {
        cwd: f.project,
        env: { PATH: '' },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const output = { stdout: '', stderr: '' }
      child.stdout.on('data', bytes => output.stdout += bytes)
      child.stderr.on('data', bytes => output.stderr += bytes)
      const result = await finish({ child, completed: once(child, 'close'), output })
      assert.equal(result.code, 0, result.stderr + result.stdout)
      assert(result.stdout.includes('NATIVE_SOURCE_READER_GUEST_OK'), result.stdout)
      assert(!result.stdout.includes(privateMarker))
      assert(!result.stderr.includes(privateMarker))
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  }, 20_000)

  it.skipIf(absent)(
    'selects the private installation for managed Native and keeps source out of public records',
    async () =>
      withService({}, async (f, url, owned) => {
        const result = await finish(start(f, url))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        owned.add(id)
        const ended = await terminal(f, id)
        const logs = await until(
          () => f.client.readLogs(id, { after: 0, limit: 256 }),
          page => page.events.some(event => event.chunk.includes('NATIVE_SOURCE_READER_GUEST_OK')),
          'reader Guest success'
        )
        assert.equal(ended.exit?.code, 0, JSON.stringify({ ended, logs }))
        const privateHost = JSON.parse(
          await readFile(
            join(f.home, 'state', 'native-processes', id, 'g1', 'host', 'host.json'),
            'utf8'
          )
        )
        assert.deepEqual(privateHost.diagnosticSourceReader, readerInstallation)
        assertPrivate(ended)
        assertPrivate(await f.client.call('/v1/processes'))
        assertPrivate(logs)
        assertPrivate(result)

        await writeFile(join(f.project, 'steal.mjs'), "import './gate.mjs';console.log('GUEST_STOLE_HOST_SOURCE')")
        const denied = await finish(start(f, url, './steal.mjs'))
        assert.equal(denied.code, 1, denied.stderr + denied.stdout)
        assert(!denied.stdout.includes('GUEST_STOLE_HOST_SOURCE'))
        assert(!denied.stderr.includes(privateMarker))
        assert.equal((await f.client.call('/v1/processes')).length, 1)
      }),
    30_000
  )

  it.skipIf(absent)('leaves the Host reader absent for installed metadataOnly and none policies', async () => {
    for (const reader of ['metadataOnly', 'none']) {
      await withService({ mode: 'metadata', reader }, async (f, url, owned) => {
        await writeFile(
          join(f.project, 'index.mjs'),
          "import assert from 'node:assert/strict';assert.equal(eval('40+2'),42);console.log('NO_HOST_READER_OK')"
        )
        const result = await finish(start(f, url))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        owned.add(id)
        const ended = await terminal(f, id)
        assert.equal(ended.exit?.code, 0, JSON.stringify(ended))
        const logs = await until(
          () => f.client.readLogs(id, { after: 0, limit: 256 }),
          page => page.events.some(event => event.chunk.includes('NO_HOST_READER_OK')),
          'metadata-only Guest success'
        )
        const privateHost = JSON.parse(
          await readFile(
            join(f.home, 'state', 'native-processes', id, 'g1', 'host', 'host.json'),
            'utf8'
          )
        )
        assert.equal(Object.hasOwn(privateHost, 'diagnosticSourceReader'), false)
        assertPrivate(logs)
      })
    }
  }, 40_000)

  it.skipIf(absent)(
    'rejects boundedSource without installation before Guest entry',
    async () =>
      withService({ installed: false }, async (f, url) => {
        await writeFile(join(f.project, 'index.mjs'), "console.log('MISSING_READER_ENTRY_WRONG')")
        const result = await finish(start(f, url))
        assert.equal(result.code, 1, result.stderr + result.stdout)
        assert(!result.stdout.includes('MISSING_READER_ENTRY_WRONG'))
        assert(!result.stderr.includes('MISSING_READER_ENTRY_WRONG'))
        assert.equal((await f.client.call('/v1/processes')).length, 0)
      }),
    20_000
  )

  it.skipIf(absent)(
    'revokes a timed-out read and isolates the next Native generation',
    async () =>
      withService({ mode: 'late' }, async (f, url, owned) => {
        await writeFile(
          join(f.project, 'index.mjs'),
          "console.log('READER_LATE_ENTER');let denied=false;try{eval('40+2')}catch{denied=true}if(!denied)throw Error('first gate was not denied');if(eval('6*7')!==42)throw Error('fresh gate was not allowed');console.log('HOST_READER_CANCELLED_READY');setInterval(()=>{},1000)"
        )
        const result = await finish(start(f, url))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        owned.add(id)
        const ready = await until(
          () => f.client.readLogs(id, { after: 0, limit: 256 }),
          page =>
            page.events.some(event => event.generation === 1 && event.chunk.includes('HOST_READER_CANCELLED_READY')),
          'first generation Host reader cancellation handshake'
        )
        assert(!ready.events.some(event => event.generation === 1 && event.chunk.includes('READER_LATE_WRONG')))
        const first = await f.client.getProcess(id)
        const stopped = await f.client.processAction(id, 'stop', first.generation, randomUUID())
        await until(() => f.client.getOperation(stopped.value.operation.id), op => op.state === 'succeeded', 'stop')
        const restarted = await f.client.processAction(id, 'restart', first.generation, randomUUID())
        await until(
          () => f.client.getOperation(restarted.value.operation.id),
          op => op.state === 'succeeded',
          'restart'
        )
        await until(
          () => f.client.readLogs(id, { after: 0, limit: 256 }),
          page =>
            page.events.some(event => event.generation === 2 && event.chunk.includes('HOST_READER_CANCELLED_READY')),
          'second generation admitted its own reader'
        )
        const logs = await f.client.readLogs(id, { after: 0, limit: 256 })
        assert.equal(logs.events.filter(event => event.chunk.includes('HOST_READER_CANCELLED_READY')).length, 2)
        assertPrivate(logs)
      }),
    30_000
  )
})

describe('owner-selected Native source-read audit through public entrypoints', () => {
  it.skipIf(absent)(
    'writes source-free admitted metadata for real Engine string, Wasm and module reads',
    async () =>
      withService({ auditBytes: 4_096 }, async (f, url, owned) => {
        const result = await finish(start(f, url))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        owned.add(id)
        assert.equal((await terminal(f, id)).exit?.code, 0)
        const rows = await readAudit(f, id)
        assert.deepEqual(rows.map(row => row.request.codeKind), ['strings', 'wasm', 'module'])
        assert.deepEqual(rows.map(row => row.sequence), [1, 2, 3])
        assert(rows.every(row => row.event === 'source.read.admitted' && row.schemaVersion === 1))
        assert(rows.every(row => row.sessionId === rows[0].sessionId && row.generation === 1))
        assert(rows.every(row => /^[0-9a-f]{64}$/u.test(row.request.sourceSha256)))
        assert(rows.every(row => row.request.readBytes > 0 && row.request.readBytes <= 5))
        const raw = await readFile(auditPath(f, id), 'utf8')
        assert(!raw.includes(privateMarker) && !raw.includes(guestMarker) && !raw.includes('40+2'))
        assert.equal((await stat(auditPath(f, id))).mode & 0o777, 0o600)
        assert.equal(
          (await stat(join(f.home, 'state', 'native-processes', id, 'g1', 'host', 'audit'))).mode & 0o777,
          0o700
        )
        const host = JSON.parse(
          await readFile(join(f.home, 'state', 'native-processes', id, 'g1', 'host', 'host.json'), 'utf8')
        )
        assert.deepEqual(host.diagnosticAudit, { path: './audit/source-reads.jsonl', maxBytes: 4_096 })
        assertPrivate(result)
        assertPrivate(await f.client.getProcess(id))
        assertPrivate(await f.client.readLogs(id, { after: 0, limit: 256 }))
      }),
    25_000
  )

  it.skipIf(absent)('omits audit writer and directory for metadataOnly and none', async () => {
    for (const reader of ['metadataOnly', 'none']) {
      await withService({ auditBytes: 1_024, mode: 'metadata', reader }, async (f, url, owned) => {
        await writeFile(
          join(f.project, 'index.mjs'),
          "if(eval('40+2')!==42)throw Error('eval');console.log('NO_AUDIT_SELECTED')"
        )
        const result = await finish(start(f, url))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        owned.add(id)
        assert.equal((await terminal(f, id)).exit?.code, 0)
        const hostRoot = join(f.home, 'state', 'native-processes', id, 'g1', 'host')
        const host = JSON.parse(await readFile(join(hostRoot, 'host.json'), 'utf8'))
        assert.equal(Object.hasOwn(host, 'diagnosticAudit'), false)
        await assert.rejects(stat(join(hostRoot, 'audit')), { code: 'ENOENT' })
        assertPrivate(result)
      })
    }
  }, 35_000)

  it.skipIf(absent)(
    'fails closed at the byte ceiling without returning an extra source copy',
    async () =>
      withService({ auditBytes: 1_024, mode: 'capacity' }, async (f, url, owned) => {
        await writeFile(
          join(f.project, 'index.mjs'),
          `
        let admitted=0, denied=0;
        for(let i=0;i<12;i++){
          try { if(eval('40+2')!==42)throw Error('wrong result'); admitted++ }
          catch { denied++ }
        }
        console.log('AUDIT_CAPACITY:'+admitted+':'+denied);
      `
        )
        const result = await finish(start(f, url))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        owned.add(id)
        assert.equal((await terminal(f, id)).exit?.code, 0)
        const logs = await until(
          () => f.client.readLogs(id, { after: 0, limit: 256 }),
          page => page.events.some(event => event.chunk.includes('AUDIT_CAPACITY:')),
          'audit capacity Guest result'
        )
        const counts = JSON.stringify(logs).match(/AUDIT_CAPACITY:(\d+):(\d+)/u)
        assert(counts, JSON.stringify(logs))
        const admitted = Number(counts[1])
        const denied = Number(counts[2])
        assert(admitted > 0 && denied > 0)
        assert.equal(admitted + denied, 12)
        const rows = await readAudit(f, id)
        assert.equal(rows.length, admitted)
        assert(rows.every(row => row.request.codeKind === 'strings'))
        assert((await stat(auditPath(f, id))).size <= 1_024)
        assertPrivate(logs)
      }),
    25_000
  )

  it.skipIf(absent)(
    'prepares an empty audit writer for profile-only Native test without ordinary config',
    async () =>
      withService({ auditBytes: 1_024 }, async (f, url, owned) => {
        await writeFile(
          join(f.project, 'audit.test.mjs'),
          `
        import test from 'node:test';
        import assert from 'node:assert/strict';
        test('profile-only audit ready',()=>assert.equal(21*2,42));
      `
        )
        const result = await finish(start(f, url, './audit.test.mjs', {
          command: 'test',
          extra: ['--reporter', 'json'],
          withConfig: false
        }))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const [selected] = await f.client.call('/v1/processes')
        assert(selected)
        owned.add(selected.id)
        assert.equal((await terminal(f, selected.id)).exit?.code, 0)
        const host = JSON.parse(
          await readFile(
            join(f.home, 'state', 'native-processes', selected.id, 'g1', 'host', 'host.json'),
            'utf8'
          )
        )
        assert.deepEqual(host.diagnosticAudit, { path: './audit/source-reads.jsonl', maxBytes: 1_024 })
        assert.deepEqual(await readAudit(f, selected.id), [])
        assert.equal((await stat(auditPath(f, selected.id))).mode & 0o777, 0o600)
        assertPrivate(result)
        assertPrivate(await f.client.getProcess(selected.id))
      }),
    25_000
  )

  it.skipIf(absent)(
    'retains the audit field and file identity through public --watch plugin replacement',
    async () =>
      withService({ auditBytes: 4_096, mode: 'watch' }, async (f, url) => {
        await writeFile(
          join(f.project, 'index.mjs'),
          `
        if(eval('40+2')!==42)throw Error('audit gate denied');
        console.log('AUDIT_WATCH_READY');setInterval(()=>{},1000);
      `
        )
        const running = start(f, url, './index.mjs', { extra: ['--watch'] })
        try {
          const selected = await until(
            () => f.client.call('/v1/processes'),
            processes => processes.length === 1,
            'watch process'
          )
          const id = selected[0].id
          await until(
            () => f.client.readLogs(id, { after: 0, limit: 256 }),
            page => page.events.some(event => event.chunk.includes('AUDIT_WATCH_READY')),
            'watch Guest readiness'
          )
          await until(
            async () => running.output.stdout,
            output => output.includes('AUDIT_WATCH_READY'),
            'CLI watch readiness'
          )
          const before = await stat(auditPath(f, id))
          const hostPath = join(f.home, 'state', 'native-processes', id, 'g1', 'host', 'host.json')
          await writeFile(
            join(f.project, 'holo.config.json'),
            JSON.stringify({ plugins: [{ config: { mode: 'watch2' }, id: 'source-reader', use: './gate.mjs' }] })
          )
          const updated = await until(
            async () => ({
              host: JSON.parse(await readFile(hostPath, 'utf8')),
              stderr: running.output.stderr
            }),
            value => JSON.stringify(value.host.plugins).includes('"watch2"'),
            'watched Host plugin revision'
          )
          assert.deepEqual(updated.host.diagnosticAudit, { path: './audit/source-reads.jsonl', maxBytes: 4_096 })
          const after = await stat(auditPath(f, id))
          assert.equal(after.dev, before.dev)
          assert.equal(after.ino, before.ino)
          assert.equal((await readAudit(f, id)).length, 1)
          assertPrivate(await f.client.getProcess(id))
        } finally {
          if (running.child.exitCode == null) running.child.kill('SIGTERM')
          await finish(running)
        }
        await until(
          () => f.client.call('/v1/processes'),
          values => values.length === 0,
          'watch CLI owned cleanup'
        )
      }),
    30_000
  )

  it.skipIf(absent)(
    'selects a fresh audit file and session on Native restart',
    async () =>
      withService({ auditBytes: 4_096, mode: 'watch' }, async (f, url, owned) => {
        await writeFile(
          join(f.project, 'index.mjs'),
          `
        if(eval('40+2')!==42)throw Error('audit gate denied');
        console.log('AUDIT_RESTART_READY');setInterval(()=>{},1000);
      `
        )
        const result = await finish(start(f, url))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        owned.add(id)
        await until(
          () => f.client.readLogs(id, { after: 0, limit: 256 }),
          page => page.events.some(event => event.generation === 1 && event.chunk.includes('AUDIT_RESTART_READY')),
          'first audit generation'
        )
        const firstFile = await stat(auditPath(f, id, 1))
        const firstRows = await readAudit(f, id, 1)
        assert.equal(firstRows.length, 1)
        const first = await f.client.getProcess(id)
        const stopped = await f.client.processAction(id, 'stop', first.generation, randomUUID())
        await until(
          () => f.client.getOperation(stopped.value.operation.id),
          value => value.state === 'succeeded',
          'stop'
        )
        const restarted = await f.client.processAction(id, 'restart', first.generation, randomUUID())
        await until(
          () => f.client.getOperation(restarted.value.operation.id),
          value => value.state === 'succeeded',
          'restart'
        )
        await until(
          () => f.client.readLogs(id, { after: 0, limit: 256 }),
          page => page.events.some(event => event.generation === 2 && event.chunk.includes('AUDIT_RESTART_READY')),
          'second audit generation'
        )
        const secondFile = await stat(auditPath(f, id, 2))
        const secondRows = await readAudit(f, id, 2)
        assert.equal(secondRows.length, 1)
        assert.notEqual(secondFile.ino, firstFile.ino)
        assert.notEqual(secondRows[0].sessionId, firstRows[0].sessionId)
        assertPrivate(await f.client.getProcess(id))
        await remove(f, id)
        owned.delete(id)
        await assert.rejects(stat(join(f.home, 'state', 'native-processes', id)), { code: 'ENOENT' })
      }),
    30_000
  )
})
