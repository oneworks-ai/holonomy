import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
// eslint-disable-next-line test/no-import-node-test -- This adapter is verified with Node's public test runner.
import test from 'node:test'

import { runtimePluginBundleDigestV1 } from 'holonomy/runtime'

import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { sandboxLimits, sandboxSession } from './sandbox-fixture.mjs'

const listen = server =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address())
    })
  })

const close = server => new Promise(resolve => server.close(resolve))

const waitFor = (read, timeoutMs = 5_000) =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const check = () => {
      const value = read()
      if (value != null) return resolve(value)
      if (Date.now() - started >= timeoutMs) return reject(new Error('Timed out waiting for Runtime output'))
      setTimeout(check, 10)
    }
    check()
  })

const pluginBundle = (source, config = {}) => {
  const url = 'holo-plugins:///fixture/index.mjs'
  const file = Object.freeze({
    sha256: createHash('sha256').update(source).digest('hex'),
    source,
    url
  })
  const bundle = {
    config,
    entryUrl: url,
    exportName: 'default',
    files: Object.freeze([file]),
    instanceId: 'fixture',
    rootUrl: 'holo-plugins:///fixture/',
    schemaVersion: 1
  }
  return Object.freeze({ ...bundle, bundleSha256: runtimePluginBundleDigestV1(bundle) })
}

const session = (source, origin) => ({
  argv: ['holonomy', '--fixture'],
  entryUrl: 'app://fixture/main.mjs',
  env: { HOLONOMY_FIXTURE_URL: `${origin}/fixture` },
  ...sandboxSession({
    limits: { ...sandboxLimits, maxRequestBodyBytes: 2 * 1024 * 1024 },
    origin,
    privateNetwork: true
  }),
  networkRules: { mode: 'passthrough', rules: [] },
  runtimeModules: [],
  syntheticModules: {},
  userModules: [{ source, url: 'app://fixture/main.mjs' }]
})

test('keeps default network denied and serves mock-only Fetch without a native provider', async t => {
  const denied = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  const mocked = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(async () => await Promise.all([denied.stop(), mocked.stop()]))
  const deniedLogs = []
  const mockedLogs = []
  denied.on('log', record => deniedLogs.push(record))
  mocked.on('log', record => mockedLogs.push(record))

  await denied.start({
    entryUrl: 'app://sandbox/denied.mjs',
    runtimeModules: [],
    syntheticModules: {},
    userModules: [{
      source: "console.log('E2E_DENIED:' + typeof fetch)",
      url: 'app://sandbox/denied.mjs'
    }]
  })
  await waitFor(() => deniedLogs.find(record => record.text === 'E2E_DENIED:undefined'))

  await mocked.start({
    entryUrl: 'app://sandbox/mock.mjs',
    ...sandboxSession({ access: 'mockOnly', origin: 'https://api.example' }),
    networkRules: {
      mode: 'failClosed',
      rules: [{
        action: { body: { kind: 'utf8', value: 'mock-only' }, status: 200, type: 'respond' },
        id: 'mock-only',
        match: { method: 'GET', path: { op: 'exact', value: '/profile' } },
        priority: 1
      }]
    },
    runtimeModules: [],
    syntheticModules: {},
    userModules: [{
      source: `
        const response = await fetch('https://api.example/profile')
        console.log('E2E_MOCK_ONLY:' + await response.text())
      `,
      url: 'app://sandbox/mock.mjs'
    }]
  })
  await waitFor(() => mockedLogs.find(record => record.text === 'E2E_MOCK_ONLY:mock-only'))
})

test('installs admitted Cordis plugins before entry and keeps entry side effects at zero on failure', async t => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', record => logs.push(record))
  const base = {
    entryUrl: 'app://plugins/main.mjs',
    runtimeModules: [],
    syntheticModules: {}
  }
  await supervisor.start({
    ...base,
    runtimePlugins: [pluginBundle(
      `
      export default (ctx, config) => {
        globalThis.pluginReady = config.value
        ctx.effect(() => () => console.log('PLUGIN_DISPOSED'))
      }
    `,
      { value: 'ready' }
    )],
    userModules: [{
      source: "console.log('PLUGIN_ENTRY_ISOLATED:' + typeof globalThis.pluginReady)",
      url: base.entryUrl
    }]
  })
  await waitFor(() => logs.find(record => record.text === 'PLUGIN_ENTRY_ISOLATED:undefined'))
  const replacement = pluginBundle(
    `
    export default (ctx, config) => {
      console.log('PLUGIN_REPLACED:' + config.value)
      ctx.effect(() => () => console.log('PLUGIN_REPLACEMENT_DISPOSED'))
    }
  `,
    { value: 'v2' }
  )
  assert.equal((await supervisor.setRuntimePlugins([replacement], 1, 2)).pluginGraphRevision, 2)
  await assert.rejects(
    () => supervisor.setRuntimePlugins([pluginBundle('export default 42')], 2, 3),
    { code: 'invalid_plugins' }
  )
  assert.equal((await supervisor.status()).pluginGraphRevision, 2)
  await supervisor.stop()

  const failing = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => failing.stop())
  const failingLogs = []
  failing.on('log', record => failingLogs.push(record))
  await assert.rejects(() =>
    failing.start({
      ...base,
      runtimePlugins: [pluginBundle('export default 42')],
      userModules: [{ source: "console.log('PLUGIN_ENTRY_MUST_NOT_RUN')", url: base.entryUrl }]
    }), { code: 'start_failed.runtime_plugins' })
  assert.equal(failingLogs.some(record => record.text === 'PLUGIN_ENTRY_MUST_NOT_RUN'), false)
})

test('runs the shared Runtime with timer, node module, real Fetch, live mock rules, and restart', async t => {
  const largeBodyBytes = (1024 * 1024) + 17
  const largeBodySha256 = createHash('sha256').update('x'.repeat(largeBodyBytes)).digest('hex')
  const largeResponseBytes = (2 * 1024 * 1024) + 1
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(request.url === '/large' ? 'z'.repeat(largeResponseBytes) : `real:${request.url}`)
  })
  const address = await listen(server)
  assert.equal(typeof address, 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(async () => {
    await supervisor.stop()
    await close(server)
  })
  const logs = []
  const diagnostics = []
  supervisor.on('log', record => logs.push(record))
  supervisor.on('network', record => diagnostics.push(record))

  const firstSource = `
    import { Buffer } from 'node:buffer'
    import process from 'node:process'
    const timer = await new Promise(resolve => setTimeout(() => resolve('timer'), 5))
    const response = await fetch(${JSON.stringify(`${origin}/real`)})
    const large = await fetch(${JSON.stringify(`${origin}/large`)})
    console.log('E2E_REAL:' + JSON.stringify({
      body: await response.text(),
      buffer: Buffer.from('node').toString('utf8'),
      largeBytes: (await large.arrayBuffer()).byteLength,
      argv: process.argv,
      fixtureUrl: process.env.HOLONOMY_FIXTURE_URL,
      timer,
      url: import.meta.url
    }))
    setTimeout(async () => {
      try {
        const mocked = await fetch(${JSON.stringify(`${origin}/mock`)})
        console.log('E2E_MOCK:' + await mocked.text())
      } catch (error) {
        console.error('E2E_MOCK_ERROR:' + String(error?.code ?? 'unknown'))
      }
    }, 250)
    setTimeout(async () => {
      try {
        const matched = await fetch(${JSON.stringify(`${origin}/sha`)}, {
          body: 'x'.repeat(${largeBodyBytes}),
          method: 'POST'
        })
        console.log('E2E_SHA:' + await matched.text())
      } catch (error) {
        console.error('E2E_SHA_ERROR:' + String(error?.code ?? 'unknown'))
      }
    }, 350)
  `
  const first = await supervisor.start(session(firstSource, origin))
  const real = await waitFor(() => logs.find(record => record.text.startsWith('E2E_REAL:')))
  assert.deepEqual(JSON.parse(real.text.slice('E2E_REAL:'.length)), {
    body: 'real:/real',
    argv: ['holonomy', '--fixture'],
    buffer: 'node',
    fixtureUrl: `${origin}/fixture`,
    largeBytes: largeResponseBytes,
    timer: 'timer',
    url: 'app://fixture/main.mjs'
  })

  await supervisor.setRules({
    mode: 'failClosed',
    rules: [{
      action: { body: { kind: 'utf8', value: 'mocked' }, status: 200, type: 'respond' },
      id: 'node-e2e-mock',
      match: { method: 'GET', origin, path: { op: 'exact', value: '/mock' } },
      priority: 1
    }, {
      action: { body: { kind: 'utf8', value: 'sha-matched' }, status: 200, type: 'respond' },
      id: 'node-e2e-sha',
      match: {
        body: { kind: 'sha256', value: largeBodySha256 },
        method: 'POST',
        origin,
        path: { op: 'exact', value: '/sha' }
      },
      priority: 2
    }]
  }, 1)
  await waitFor(() => logs.find(record => record.text === 'E2E_MOCK:mocked'))
  await waitFor(() => logs.find(record => record.text === 'E2E_SHA:sha-matched'))
  await waitFor(() =>
    diagnostics.find(record =>
      record.diagnostic?.type === 'responseReceived' &&
      record.diagnostic.url === `${origin}/mock`
    )
  )

  assert.ok(diagnostics.some(record =>
    record.diagnostic?.layer === 'transport' &&
    record.diagnostic.kind === 'dispatch'
  ))
  assert.ok(diagnostics.some(record =>
    record.diagnostic?.layer === 'fetch' &&
    record.diagnostic.type === 'loadingFinished'
  ))
  const realRequest = diagnostics.find(record =>
    record.diagnostic?.type === 'requestWillBeSent' && record.diagnostic.url === `${origin}/real`
  )?.diagnostic
  const largeRequest = diagnostics.find(record =>
    record.diagnostic?.type === 'requestWillBeSent' && record.diagnostic.url === `${origin}/large`
  )?.diagnostic
  assert.ok(realRequest)
  assert.ok(largeRequest)
  assert.equal(
    diagnostics.find(record =>
      record.diagnostic?.type === 'responseReceived' &&
      record.diagnostic.requestId === realRequest.requestId
    )?.diagnostic.source,
    'real'
  )
  assert.equal(
    diagnostics.find(record =>
      record.diagnostic?.type === 'responseReceived' &&
      record.diagnostic.url === `${origin}/mock`
    )?.diagnostic.source,
    'mock'
  )
  const capturedBytes = diagnostics
    .filter(record =>
      record.diagnostic?.type === 'dataReceived' &&
      record.diagnostic.requestId === realRequest.requestId &&
      typeof record.diagnostic.dataBase64 === 'string'
    )
    .reduce((total, record) => total + Buffer.from(record.diagnostic.dataBase64, 'base64').byteLength, 0)
  assert.equal(capturedBytes, 'real:/real'.length)
  const largeData = diagnostics.filter(record =>
    record.diagnostic?.type === 'dataReceived' &&
    record.diagnostic.requestId === largeRequest.requestId
  )
  const largeCapturedBytes = largeData
    .filter(record => typeof record.diagnostic.dataBase64 === 'string')
    .reduce((total, record) => total + Buffer.from(record.diagnostic.dataBase64, 'base64').byteLength, 0)
  assert.ok(largeCapturedBytes > 0)
  assert.ok(largeCapturedBytes <= 2 * 1024 * 1024)
  assert.ok(largeData.some(record => record.diagnostic.bodyUnavailable === true))

  const second = await supervisor.restart(session("console.log('E2E_RESTART:' + import.meta.url)", origin))
  assert.equal(supervisor.generation, 2)
  assert.notEqual(second.pid, first.pid)
  await waitFor(() =>
    logs.find(record =>
      record.generation === 2 &&
      record.text === 'E2E_RESTART:app://fixture/main.mjs'
    )
  )
})
