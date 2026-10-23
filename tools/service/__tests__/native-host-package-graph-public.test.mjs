import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

import { createHolonomyServiceLifecycleManager } from '../lifecycle-manager.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'
import { createNativeHostGraphFixture } from './native-plugin-v2-fixture.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const absent = binary == null || process.platform !== 'darwin'
const cli = fileURLToPath(new URL('../../holonomy.mjs', import.meta.url))
const terminalStates = new Set(['cancelled', 'exited', 'failed', 'lost'])
const until = async (read, accept, label) => {
  const end = Date.now() + 12_000
  let value
  do {
    value = await read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  } while (Date.now() < end)
  assert.fail(`${label}: ${JSON.stringify(value)}`)
}

const withFixture = async (placement, body, { nestedHome = false } = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-native-host-graph-')))
  const project = join(root, 'project')
  const home = nestedHome ? join(project, 'private-home') : join(root, 'home')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(
    join(home, 'native-runtime.json'),
    JSON.stringify({
      executablePath: await realpath(binary),
      schemaVersion: 1
    }),
    { mode: 0o600 }
  )
  const source = await createNativeHostGraphFixture(project, placement)
  const client = new HolonomyServiceClient({ home, environment: {} })
  const manager = createHolonomyServiceLifecycleManager({ home, client, service: { port: 0 } })
  let started
  try {
    started = await manager.ensure()
    return await body({ ...source, client, home, project, url: started.endpoint.baseUrl })
  } finally {
    if (started != null) await manager.stop({ drain: true })
    await rm(root, { recursive: true, force: true })
  }
}

const run = (f, command, entry, flags) => {
  const env = { ...process.env, HOLONOMY_HOME: f.home }
  for (const key of ['HOLONOMY_OPENAPI_TOKEN', 'HOLONOMY_SERVICE_TOKEN']) delete env[key]
  const child = spawn(process.execPath, [
    cli,
    command,
    entry,
    '--target',
    'native',
    '--config',
    './holo.config.json',
    '--openapi',
    `${f.url}/openapi.json`,
    '--openapi-token-file',
    join(f.home, 'token'),
    ...flags
  ], { cwd: f.project, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', bytes => output.stdout = (output.stdout + bytes).slice(-128 * 1024))
  child.stderr.on('data', bytes => output.stderr = (output.stderr + bytes).slice(-128 * 1024))
  return { child, completed: once(child, 'close'), output }
}
const finish = async running => {
  const timeout = setTimeout(() => running.child.kill('SIGKILL'), 15_000)
  try {
    const [code, signal] = await running.completed
    return { code, signal, ...running.output }
  } finally {
    clearTimeout(timeout)
  }
}
const ended = (f, id) => until(() => f.client.getProcess(id), value => terminalStates.has(value.state), 'terminal')
const logs = (f, id, marker) =>
  until(
    () => f.client.readLogs(id, { after: 0, limit: 128 }),
    page => page.events.some(event => event.chunk.includes(marker)),
    marker
  )
const assertPrivate = (...values) => {
  const text = JSON.stringify(values)
  for (
    const value of [
      'sourceClosure',
      'source-graph.json',
      'PACKAGE_GRAPH_V2_OK',
      'node_modules/.pnpm',
      'metadataOnly',
      'moduleMetadataOnly',
      'HOST_SHARED_METADATA_PRIVATE_FIELD'
    ]
  ) {
    assert(!text.includes(value), value)
  }
}

describe('public Native Host package graph infrastructure', () => {
  it.skipIf(absent)('loads package exports/imports and pnpm alias singleton before index.js', async () => {
    await withFixture('package', async f => {
      const result = await finish(run(f, 'run', './index.js', ['--detach']))
      assert.equal(result.code, 0, result.stderr + result.stdout)
      const id = JSON.parse(result.stdout).processId
      assert.equal((await ended(f, id)).exit?.code, 0)
      const page = await logs(f, id, 'GUEST_INDEX_JS_OK')
      const host = JSON.parse(
        await readFile(
          join(f.home, 'state', 'native-processes', id, 'g1', 'host', 'host.json'),
          'utf8'
        )
      )
      assert(host.plugins[0].sourceGraph.endsWith('/source-graph.json'))
      assertPrivate(result, page, await f.client.getProcess(id))
      await f.client.removeProcess(id, 1, randomUUID())
    })
  }, 25_000)

  it.skipIf(absent)('runs a real Guest node:test with the same private dependency graph', async () => {
    await withFixture('package', async f => {
      await writeFile(
        join(f.project, 'graph.test.cjs'),
        `
        const test = require('node:test');
        const assert = require('node:assert/strict');
        test('Native package graph Guest entry', () => assert.equal(21*2,42));
      `
      )
      const result = await finish(run(f, 'test', './graph.test.cjs', ['--reporter', 'json']))
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
      assertPrivate(result)
    })
  }, 25_000)

  it.skipIf(absent)('keeps the local Host graph live when watch tries to claim Guest code', async () => {
    await withFixture('local', async f => {
      await writeFile(join(f.project, 'index.js'), "console.log('LOCAL_GRAPH_WATCH_READY');setInterval(()=>{},1000)")
      const running = run(f, 'run', './index.js', ['--watch'])
      try {
        const [selected] = await until(
          () => f.client.call('/v1/processes'),
          rows => rows.length === 1,
          'watched local process'
        )
        await logs(f, selected.id, 'LOCAL_GRAPH_WATCH_READY')
        // CLI log forwarding begins only after its config watcher is installed.
        await until(
          async () => running.output.stdout,
          text => text.includes('LOCAL_GRAPH_WATCH_READY'),
          'CLI local watch ready'
        )
        const initialRevision = (await f.client.getProcess(selected.id)).pluginGraphRevision
        assert(Number.isSafeInteger(initialRevision))
        await writeFile(
          f.configPath,
          JSON.stringify({ plugins: [{ id: 'graph', use: './index.js' }] })
        )
        await until(
          async () => running.output.stderr,
          text => text.includes('remains active; candidate was rejected'),
          'rejected Guest-to-Host watch candidate'
        )
        const retained = await f.client.getProcess(selected.id)
        assert.equal(retained.pluginGraphRevision, initialRevision)
        assert.equal(retained.state, 'running')
        await writeFile(
          f.configPath,
          JSON.stringify({ plugins: [{ id: 'graph', use: './host/gate.mjs', config: { revision: 2 } }] })
        )
        const updated = await until(
          () => f.client.getProcess(selected.id),
          value => value.pluginGraphRevision === initialRevision + 1,
          'accepted local graph after rejected watch candidate'
        )
        assert.equal(updated.generation, 1)
        assert.equal(updated.state, 'running')
        assertPrivate(updated)
      } finally {
        if (running.child.exitCode == null) running.child.kill('SIGTERM')
        await finish(running)
      }
      await until(() => f.client.call('/v1/processes'), rows => rows.length === 0, 'local watch cleanup')
    })
  }, 35_000)

  it.skipIf(absent)('replaces the package graph through public config watch without restarting Guest', async () => {
    await withFixture('package', async f => {
      await writeFile(join(f.project, 'index.js'), "console.log('GRAPH_WATCH_READY');setInterval(()=>{},1000)")
      const running = run(f, 'run', './index.js', ['--watch'])
      try {
        const [selected] = await until(
          () => f.client.call('/v1/processes'),
          rows => rows.length === 1,
          'watched process'
        )
        await logs(f, selected.id, 'GRAPH_WATCH_READY')
        await until(async () => running.output.stdout, text => text.includes('GRAPH_WATCH_READY'), 'CLI watch ready')
        await writeFile(
          f.configPath,
          JSON.stringify({
            plugins: [{ id: 'graph', use: 'host-gate', config: { revision: 2 } }]
          })
        )
        const updated = await until(
          () => f.client.getProcess(selected.id),
          value => value.pluginGraphRevision === 2,
          'V2 watch revision'
        )
        assert.equal(updated.generation, 1)
        assert.equal(updated.state, 'running')
        assertPrivate(updated, await f.client.readLogs(selected.id, { after: 0, limit: 128 }))
      } finally {
        if (running.child.exitCode == null) running.child.kill('SIGTERM')
        await finish(running)
      }
      await until(() => f.client.call('/v1/processes'), rows => rows.length === 0, 'watch cleanup')
    })
  }, 35_000)

  it.skipIf(absent)('loads a local Host graph and Guest index.js through shared project metadata', async () => {
    await withFixture('local', async f => {
      const result = await finish(run(f, 'run', './index.js', ['--detach']))
      assert.equal(result.code, 0, result.stderr + result.stdout)
      const id = JSON.parse(result.stdout).processId
      assert.equal((await ended(f, id)).exit?.code, 0)
      const page = await logs(f, id, 'GUEST_INDEX_JS_OK')
      assertPrivate(result, page, await f.client.getProcess(id))
      await f.client.removeProcess(id, 1, randomUUID())
    })
  }, 25_000)

  it.skipIf(absent)('rejects raw shared package JSON in static import and require graphs', async () => {
    await withFixture('local', async f => {
      const privateMarker = 'HOST_METADATA_PRIVATE_FIELD'
      await writeFile(join(f.project, 'package.json'), JSON.stringify({ type: 'module', privateMarker }))
      for (
        const [entry, source] of [
          ['raw.mjs', "import metadata from './package.json'; console.log(metadata.privateMarker)"],
          ['raw.cjs', "const metadata = require('./package.json'); console.log(metadata.privateMarker)"]
        ]
      ) {
        await writeFile(join(f.project, entry), source)
        const result = await finish(run(f, 'run', `./${entry}`, ['--detach']))
        assert.equal(result.code, 1, result.stderr + result.stdout)
        assert.match(result.stderr, /The Holonomy module host could not read a requested module/u)
        assert(!`${result.stdout}${result.stderr}`.includes(privateMarker))
        assert.deepEqual(await f.client.call('/v1/processes'), [])
      }
    })
  }, 25_000)

  it.skipIf(absent)('reserves a nested managed home before Guest JSON collection', async () => {
    await withFixture('local', async f => {
      const privateMarker = 'NESTED_MANAGED_HOME_PRIVATE_MARKER'
      await writeFile(
        join(f.home, 'private-probe.json'),
        JSON.stringify({ privateMarker }),
        { mode: 0o600 }
      )
      await symlink('private-home', join(f.project, 'home-link'))
      for (
        const [entry, source] of [
          ['home-direct.cjs', "require('./private-home/private-probe.json')"],
          ['home-link.cjs', "require('./home-link/private-probe.json')"]
        ]
      ) {
        await writeFile(join(f.project, entry), `${source};console.log('PRIVATE_HOME_MUST_NOT_RUN')`)
        const result = await finish(run(f, 'run', `./${entry}`, ['--detach']))
        assert.equal(result.code, 1, result.stderr + result.stdout)
        assert.match(result.stderr, /The Holonomy module host could not read a requested module/u)
        assert(!`${result.stdout}${result.stderr}`.includes(privateMarker))
        assert(!result.stdout.includes('PRIVATE_HOME_MUST_NOT_RUN'))
        assert.deepEqual(await f.client.call('/v1/processes'), [])
      }
    }, { nestedHome: true })
  }, 25_000)

  it.skipIf(absent)('rejects computed dynamic JSON import after the metadata cache is warm', async () => {
    await withFixture('local', async f => {
      const privateMarker = 'HOST_METADATA_DYNAMIC_PRIVATE_FIELD'
      await writeFile(join(f.project, 'package.json'), `\uFEFF${JSON.stringify({ type: 'module', privateMarker })}`)
      await writeFile(
        f.gateEntry,
        [
          "import * as first from 'dep'",
          "import * as second from 'dep-alias'",
          "if (first !== second || first.token !== 'PACKAGE_GRAPH_V2_OK') throw Error('Host package alias is not singleton')",
          "export default function gate(ctx) { ctx.holo.engineGate(() => ({ action: 'allow' })) }",
          ''
        ].join('\n')
      )
      await writeFile(
        join(f.project, 'capability.json'),
        JSON.stringify({
          context: { guest: { application: { id: 'metadata.guest', name: 'Metadata Guest' } }, schemaVersion: 1 },
          initialMiddlewareId: 'service.continue.v1',
          sandboxPolicy: {
            codeGeneration: {
              dynamicImport: { access: 'controlled', decisionTimeoutMs: 1000, maxOperations: 2, maxSourceBytes: 4096 },
              strings: { access: 'none' },
              wasm: { access: 'none' }
            },
            schemaVersion: 2
          },
          schemaVersion: 1
        })
      )
      await writeFile(
        join(f.project, 'index.js'),
        [
          "const specifier = './package.json'",
          'let denied = false',
          'try { await import(specifier) } catch (error) {',
          "  if (error?.code !== 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED') throw error",
          '  denied = true',
          '}',
          "if (!denied) throw Error('restricted metadata became a JSON module')",
          "console.log('GUEST_METADATA_DYNAMIC_DENIED_OK')",
          ''
        ].join('\n')
      )
      const result = await finish(run(f, 'run', './index.js', [
        '--detach',
        '--capability-runtime',
        './capability.json'
      ]))
      assert.equal(result.code, 0, result.stderr + result.stdout)
      const id = JSON.parse(result.stdout).processId
      const final = await ended(f, id)
      assert.equal(
        final.exit?.code,
        0,
        JSON.stringify({ final, logs: await f.client.readLogs(id, { after: 0, limit: 128 }) })
      )
      const page = await logs(f, id, 'GUEST_METADATA_DYNAMIC_DENIED_OK')
      assert(!JSON.stringify(page).includes(privateMarker))
      await f.client.removeProcess(id, 1, randomUUID())
    })
  }, 25_000)

  it.skipIf(absent)('keeps ordinary Guest package JSON require without a Host graph', async () => {
    await withFixture('local', async f => {
      await writeFile(f.configPath, JSON.stringify({ plugins: [] }))
      await writeFile(join(f.project, 'package.json'), JSON.stringify({ type: 'module', value: 42 }))
      await writeFile(
        join(f.project, 'json.cjs'),
        [
          "const value = require('./package.json')",
          "if (value.value !== 42) throw Error('Guest JSON content changed')",
          "console.log('GUEST_JSON_REQUIRE_OK')"
        ].join('\n')
      )
      const result = await finish(run(f, 'run', './json.cjs', ['--detach']))
      assert.equal(result.code, 0, result.stderr + result.stdout)
      const id = JSON.parse(result.stdout).processId
      assert.equal((await ended(f, id)).exit?.code, 0)
      await logs(f, id, 'GUEST_JSON_REQUIRE_OK')
      await f.client.removeProcess(id, 1, randomUUID())
    })
  }, 25_000)
})
