import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

import { createHolonomyServiceLifecycleManager } from '../lifecycle-manager.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const absent = binary == null || process.platform !== 'darwin'
const cli = fileURLToPath(new URL('../../holonomy.mjs', import.meta.url))
const wasmBytes = [0, 97, 115, 109, 1, 0, 0, 0]
const lazySource = 'globalThis.lazyRuns=(globalThis.lazyRuns??0)+1;export const value=42;'
const privateMarker = 'HOST_GATE_PRIVATE_SOURCE_SENTINEL'
const digest = value => createHash('sha256').update(value).digest('hex')
const controlled = (maxOperations = 4, decisionTimeoutMs = 500) => ({
  access: 'controlled',
  decisionTimeoutMs,
  maxOperations,
  maxSourceBytes: 4096
})
const policy = (mode = 'controlled', decisionTimeoutMs = 500) => ({
  codeGeneration: {
    dynamicImport: mode === 'none' ? { access: 'none' } : controlled(3, decisionTimeoutMs),
    strings: { access: 'none' },
    wasm: mode === 'none' ? { access: 'none' } : controlled(2, decisionTimeoutMs)
  },
  schemaVersion: 2
})
const pluginSource = `
const privateSource = '${privateMarker}';
export default (ctx, config) => {
  let wasmCalls = 0;
  let moduleCalls = 0;
  let wasmTimed = false;
  let moduleTimed = false;
  let wasmAbortObserved = false;
  let moduleAbortObserved = false;
  if (config.mode === 'missing') return;
  ctx.holo.engineGate(async request => {
    void privateSource;
    if (config.mode === 'pending') {
      await new Promise(resolve => setTimeout(resolve, 1800));
      return { action: 'allow' };
    }
    if (config.mode === 'timeout') {
      const wasm = request.operation === 'runtime.code.generate.wasm';
      if (wasm ? !wasmTimed : !moduleTimed) {
        if (wasm) wasmTimed = true;
        else moduleTimed = true;
        await new Promise(resolve => setTimeout(resolve, 90));
        if (wasm) wasmAbortObserved = request.signal.aborted;
        else moduleAbortObserved = request.signal.aborted;
        return { action: 'allow' };
      }
      return (wasm ? wasmAbortObserved : moduleAbortObserved)
        ? { action: 'deny', reasonCode: 'host.abort_observed' }
        : { action: 'allow' };
    }
    if (config.mode === 'deny') return { action: 'deny', reasonCode: 'host.fixture_denied' };
    if (request.operation === 'runtime.code.generate.wasm') {
      if (request.codeKind !== 'wasm' || request.sourceSha256 !== config.wasmSha ||
          request.sourceBytes !== 8 || ++wasmCalls > 2)
        return { action: 'deny', reasonCode: 'host.unexpected_wasm' };
      return { action: 'allow' };
    }
    if (request.operation === 'runtime.module.import') {
      if (request.origin === 'app://workspace/uncaptured.mjs') return { action: 'allow' };
      if (request.codeKind !== 'module' || request.origin !== 'app://workspace/lazy.mjs' ||
          request.entryDetail?.kind !== 'dynamicImport' || request.entryDetail?.source !== 'loader' ||
          request.sourceSha256 !== config.lazySha || ++moduleCalls > 1)
        return { action: 'deny', reasonCode: 'host.unexpected_module' };
      return { action: 'allow' };
    }
    return { action: 'deny', reasonCode: 'host.unexpected_operation' };
  });
};`

const fixture = async (mode = 'allow', policyMode = 'controlled', decisionTimeoutMs = 500) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-native-managed-gates-')))
  const home = join(root, 'home')
  const project = join(root, 'project')
  await mkdir(home)
  await mkdir(project)
  if (!absent) {
    await writeFile(join(home, 'native-runtime.json'), JSON.stringify({ executablePath: binary, schemaVersion: 1 }), {
      mode: 0o600
    })
  }
  await writeFile(join(project, 'gate.mjs'), pluginSource)
  await writeFile(join(project, 'lazy.mjs'), lazySource)
  await writeFile(join(project, 'uncaptured.mjs'), 'globalThis.uncapturedRan=true;export const value=99;')
  await writeFile(
    join(project, 'holo.config.json'),
    JSON.stringify({
      plugins: [{
        config: { lazySha: digest(lazySource), mode, wasmSha: digest(Buffer.from(wasmBytes)) },
        id: 'native-engine-gate',
        use: './gate.mjs'
      }]
    })
  )
  await writeFile(
    join(project, 'capability.json'),
    JSON.stringify({
      context: {
        guest: { application: { id: 'native.managed.gates', name: 'Native managed Gates' } },
        host: { tenantId: privateMarker },
        schemaVersion: 1
      },
      initialMiddlewareId: 'service.continue.v1',
      sandboxPolicy: policy(policyMode, decisionTimeoutMs),
      schemaVersion: 1
    })
  )
  const client = new HolonomyServiceClient({ home, environment: {} })
  const manager = createHolonomyServiceLifecycleManager({ client, home, service: { port: 0 } })
  return { client, home, manager, project, root }
}

const startCli = (f, url, command, entry, extra = [], withConfig = true, target = 'native') => {
  const child = spawn(process.execPath, [
    cli,
    command,
    entry,
    '--target',
    target,
    ...(withConfig ? ['--config', 'holo.config.json'] : []),
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
  for (let turn = 0; turn < 600; turn++) {
    latest = await read()
    if (accepts(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`${label} did not settle: ${JSON.stringify(latest)}`)
}
const terminal = async (f, id) =>
  until(
    () => f.client.getProcess(id),
    value => ['cancelled', 'exited', 'failed', 'lost'].includes(value.state) && value.cleanupPending !== true,
    'Native process'
  )
const remove = async (f, id) => {
  const current = await f.client.getProcess(id)
  if (!['cancelled', 'exited', 'failed', 'lost'].includes(current.state)) {
    const stop = await f.client.processAction(id, 'stop', current.generation, randomUUID())
    await until(() => f.client.getOperation(stop.value.operation.id), value => value.state === 'succeeded', 'stop')
  }
  const ended = await terminal(f, id)
  await f.client.removeProcess(id, ended.generation, randomUUID())
}
const withService = async (options, body) => {
  const f = await fixture(options.mode, options.policyMode, options.decisionTimeoutMs)
  const owned = new Set()
  let running
  try {
    const service = await f.manager.ensure()
    running = service
    return await body(f, service.endpoint.baseUrl, owned)
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

describe('public CLI -> Service -> Native managed engine Gates', () => {
  it.skipIf(absent)(
    'approves exact Wasm and captured dynamic module, gates cache hits, and confines the source closure',
    async () =>
      withService({ mode: 'allow' }, async (f, url, owned) => {
        await writeFile(
          join(f.project, 'index.mjs'),
          `
        import assert from 'node:assert/strict';
        const bytes=Uint8Array.from(${JSON.stringify(wasmBytes)});
        const compiled=await WebAssembly.compile(bytes);
        assert.ok(compiled instanceof WebAssembly.Module);
        const instantiated=await WebAssembly.instantiate(bytes);
        assert.ok(instantiated.module instanceof WebAssembly.Module);
        assert.ok(instantiated.instance instanceof WebAssembly.Instance);
        await assert.rejects(WebAssembly.compile(bytes));
        assert.equal((await import('./lazy.mjs')).value,42);
        assert.equal(globalThis.lazyRuns,1);
        await assert.rejects(import('./lazy.mjs'));
        assert.equal(globalThis.lazyRuns,1);
        const uncaptured='./uncaptured.mjs';
        await assert.rejects(import(uncaptured));
        assert.equal(globalThis.uncapturedRan,undefined);
        console.log('MANAGED_GATES_ALLOW_OK');
      `
        )
        const result = await finish(startCli(f, url, 'run', './index.mjs', ['--detach']))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        owned.add(id)
        const ended = await terminal(f, id)
        const logs = await until(
          () => f.client.readLogs(id, { after: 0, limit: 256 }),
          value => value.events.some(event => event.chunk.includes('MANAGED_GATES_ALLOW_OK')),
          'allowed Guest log'
        )
        assert.equal(ended.exit?.code, 0, JSON.stringify({ ended, logs }))
        assert(!JSON.stringify(ended).includes(privateMarker))
        assert(!JSON.stringify(logs).includes(privateMarker))
        assert(!JSON.stringify(ended).includes(f.root))
      }),
    25_000
  )

  it.skipIf(absent)(
    'runs Guest node:test through Host denial without evaluating the dynamic module',
    async () =>
      withService({ mode: 'deny' }, async (f, url, owned) => {
        await writeFile(
          join(f.project, 'denied.test.mjs'),
          `
        import {test} from 'node:test';
        import assert from 'node:assert/strict';
        test('Host denial remains Guest-visible',async()=>{
          const bytes=Uint8Array.from(${JSON.stringify(wasmBytes)});
          const opaque=error=>{
            const visible=String(error)+' '+String(error?.stack);
            assert.equal(visible.includes('${privateMarker}'),false);
            assert.equal(visible.includes('gate.mjs'),false);
            assert.equal(visible.includes('/holo-native-managed-gates-'),false);
            return true;
          };
          await assert.rejects(WebAssembly.compile(bytes),opaque);
          await assert.rejects(import('./lazy.mjs'),opaque);
          assert.equal(globalThis.lazyRuns,undefined);
          console.log('MANAGED_GATES_DENY_OK');
        });
      `
        )
        const result = await finish(startCli(f, url, 'test', './denied.test.mjs', ['--reporter', 'json']))
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
        const [process] = await f.client.call('/v1/processes')
        assert(process)
        owned.add(process.id)
        const ended = await terminal(f, process.id)
        assert.equal(ended.exit?.code, 0)
        assert(!JSON.stringify(report).includes(privateMarker))
        assert(!JSON.stringify(ended).includes(f.root))
      }),
    25_000
  )

  it.skipIf(absent)(
    'denies missing handler and timed-out late allow before any module side effect',
    async () => {
      for (
        const options of [
          { mode: 'missing' },
          { mode: 'timeout', decisionTimeoutMs: 30 }
        ]
      ) {
        await withService(options, async (f, url, owned) => {
          await writeFile(
            join(f.project, 'index.mjs'),
            `
            import assert from 'node:assert/strict';
            const bytes=Uint8Array.from(${JSON.stringify(wasmBytes)});
            await assert.rejects(WebAssembly.compile(bytes));
            await assert.rejects(import('./lazy.mjs'));
            await new Promise(resolve=>setTimeout(resolve,120));
            if (${JSON.stringify(options.mode)}==='timeout') {
              await assert.rejects(WebAssembly.compile(bytes));
              await assert.rejects(import('./lazy.mjs'));
            }
            assert.equal(globalThis.lazyRuns,undefined);
            console.log('MANAGED_GATES_CLOSED_OK');
          `
          )
          const result = await finish(startCli(f, url, 'run', './index.mjs', ['--detach']))
          assert.equal(result.code, 0, result.stderr + result.stdout)
          const id = JSON.parse(result.stdout).processId
          owned.add(id)
          const ended = await terminal(f, id)
          const logs = await until(
            () => f.client.readLogs(id, { after: 0, limit: 256 }),
            value => value.events.some(event => event.chunk.includes('MANAGED_GATES_CLOSED_OK')),
            'closed Gate Guest log'
          )
          assert.equal(ended.exit?.code, 0, JSON.stringify({ ended, logs }))
          assert(!JSON.stringify(logs).includes(privateMarker))
          assert(!JSON.stringify(ended).includes(f.root))
        })
      }
    },
    50_000
  )

  it.skipIf(absent)(
    'runs Guest node:test for Wasm Policy none and rejects dynamic import at public admission',
    async () =>
      withService({ mode: 'allow', policyMode: 'none' }, async (f, url, owned) => {
        await writeFile(
          join(f.project, 'none.test.mjs'),
          `
        import {test} from 'node:test';
        import assert from 'node:assert/strict';
        test('Wasm Policy none rejects before compilation',async()=>{
          const bytes=Uint8Array.from(${JSON.stringify(wasmBytes)});
          await assert.rejects(WebAssembly.compile(bytes));
          console.log('MANAGED_GATES_POLICY_NONE_OK');
        });
      `
        )
        const result = await finish(startCli(f, url, 'test', './none.test.mjs', ['--reporter', 'json'], false))
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
        const [process] = await f.client.call('/v1/processes')
        assert(process)
        owned.add(process.id)
        assert.equal((await terminal(f, process.id)).exit?.code, 0)
        assert(!JSON.stringify(report).includes(privateMarker))

        await writeFile(
          join(f.project, 'none.mjs'),
          "const target='./lazy.mjs';await import(target);console.log('UNREACHABLE')"
        )
        const denied = await finish(startCli(f, url, 'run', './none.mjs', ['--detach']))
        assert.equal(denied.code, 1, denied.stderr + denied.stdout)
        assert(!denied.stdout.includes('UNREACHABLE'))
        assert(!denied.stderr.includes(privateMarker))
        assert.equal((await f.client.call('/v1/processes')).length, 1)
      }),
    25_000
  )

  it(
    'keeps static --config working for public Node test and blocks Guest on Host plugin init failure',
    async () =>
      withService({ mode: 'allow', policyMode: 'none' }, async (f, url, owned) => {
        await writeFile(
          join(f.project, 'node.test.mjs'),
          `
        import {test} from 'node:test';
        import assert from 'node:assert/strict';
        test('Node public test with Host config',()=>{
          assert.equal(40+2,42);
          console.log('NODE_CONFIG_TEST_GUEST');
        });
      `
        )
        await writeFile(join(f.project, 'gate.mjs'), 'export default()=>{}\n')
        const invoke = () => finish(startCli(f, url, 'test', './node.test.mjs', ['--reporter', 'json'], true, 'node'))
        const passed = await invoke()
        assert.equal(passed.code, 0, passed.stderr + passed.stdout)
        assert(passed.stdout.includes('NODE_CONFIG_TEST_GUEST'), passed.stdout)
        for (const process of await f.client.call('/v1/processes')) owned.add(process.id)

        await writeFile(
          join(f.project, 'gate.mjs'),
          "export default()=>{throw new Error('HOST_PLUGIN_INIT_BLOCKED')}\n"
        )
        const blocked = await invoke()
        assert.equal(blocked.code, 1, blocked.stderr + blocked.stdout)
        assert(!blocked.stdout.includes('NODE_CONFIG_TEST_GUEST'))
        assert(!blocked.stderr.includes('NODE_CONFIG_TEST_GUEST'))
        for (const process of await f.client.call('/v1/processes')) owned.add(process.id)
      }),
    25_000
  )

  it.skipIf(absent)(
    'stops a real Native generation before its in-flight Wasm Gate can approve',
    async () =>
      withService({ mode: 'pending', decisionTimeoutMs: 4000 }, async (f, url, owned) => {
        await writeFile(
          join(f.project, 'pending.mjs'),
          `
        const bytes=Uint8Array.from(${JSON.stringify(wasmBytes)});
        console.log('MANAGED_GATE_STOP_ENTRY');
        await WebAssembly.compile(bytes);
        console.log('MANAGED_GATE_STOP_WRONG');
      `
        )
        const result = await finish(startCli(f, url, 'run', './pending.mjs', ['--detach']))
        assert.equal(result.code, 0, result.stderr + result.stdout)
        const id = JSON.parse(result.stdout).processId
        owned.add(id)
        const preStop = await until(
          () => f.client.readLogs(id, { after: 0, limit: 256 }),
          value => value.events.some(event => event.chunk.includes('MANAGED_GATE_STOP_ENTRY')),
          'Guest pre-Gate invocation'
        )
        assert(!preStop.events.some(event => event.chunk.includes('MANAGED_GATE_STOP_WRONG')))
        const active = await f.client.getProcess(id)
        assert.equal(active.state, 'running')
        const stop = await f.client.processAction(id, 'stop', active.generation, randomUUID())
        const operation = await until(
          () => f.client.getOperation(stop.value.operation.id),
          value => ['succeeded', 'failed', 'cancelled'].includes(value.state),
          'in-flight public stop'
        )
        assert.equal(operation.state, 'succeeded', JSON.stringify(operation))
        const ended = await terminal(f, id)
        assert.equal(ended.state, 'cancelled')
        const logs = await f.client.readLogs(id, { after: 0, limit: 256 })
        assert(!logs.events.some(event => event.chunk.includes('MANAGED_GATE_STOP_WRONG')))
      }),
    20_000
  )
})
