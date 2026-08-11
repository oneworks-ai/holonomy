import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
// eslint-disable-next-line test/no-import-node-test -- This adapter is verified with Node's public test runner.
import test from 'node:test'

import { prepareHolonomyNodeSession } from '../src/runtime-assets.mjs'
import { normalizeNodeRuntimeSession } from '../src/session-validation.mjs'
import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { sandboxSession } from './sandbox-fixture.mjs'

const createSession = (message, overrides = {}) => ({
  entryUrl: 'app://fixture/main.mjs',
  runtimeModules: [],
  syntheticModules: {},
  userModules: [{ source: `console.log(${JSON.stringify(message)})`, url: 'app://fixture/main.mjs' }],
  ...overrides
})

test('starts, updates rules, reports diagnostics, restarts, and stops by generation', async t => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5_000 })
  t.after(() => supervisor.stop())
  const logs = []
  const network = []
  supervisor.on('log', event => logs.push(event))
  supervisor.on('network', event => network.push(event))

  const first = await supervisor.start(createSession('first', {
    ...sandboxSession({ origin: 'https://example.test' })
  }))
  assert.equal(supervisor.state, 'running')
  assert.equal(first.rulesRevision, 0)
  assert.ok(logs.some(record => record.text === 'first'))

  await supervisor.setRules({ mode: 'passthrough', rules: [] }, 7)
  await assert.rejects(() => supervisor.setRules({ mode: 'passthrough', rules: [] }, 7), {
    code: 'invalid_rules_revision'
  })
  assert.equal((await supervisor.status()).rulesRevision, 7)
  assert.equal(
    JSON.stringify(network[0].diagnostic),
    JSON.stringify({ kind: 'rules.updated', revision: 7, ruleCount: 0 })
  )

  const second = await supervisor.restart(createSession('second'))
  assert.equal(supervisor.generation, 2)
  assert.notEqual(second.pid, first.pid)
  assert.ok(logs.some(record => record.text === 'second'))
  const third = await supervisor.restart()
  assert.equal(supervisor.generation, 3)
  assert.notEqual(third.pid, second.pid)
  assert.ok(logs.filter(record => record.text === 'second').length >= 2)
  await Promise.all([supervisor.stop(), supervisor.stop()])
  assert.equal(supervisor.state, 'stopped')
})

test('uses one independent child process per runtime supervisor', async t => {
  const first = new NodeRuntimeSupervisor({ requestTimeoutMs: 5_000 })
  const second = new NodeRuntimeSupervisor({ requestTimeoutMs: 5_000 })
  t.after(() => Promise.all([first.stop(), second.stop()]))

  const [firstStatus, secondStatus] = await Promise.all([
    first.start(createSession('one')),
    second.start(createSession('two'))
  ])

  assert.notEqual(firstStatus.pid, secondStatus.pid)
  assert.equal(first.state, 'running')
  assert.equal(second.state, 'running')
})

test('reports the inspector endpoint for the exact runtime child', async t => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5_000 })
  t.after(() => supervisor.stop())
  const endpoints = []
  supervisor.on('inspector', event => endpoints.push(event))

  const status = await supervisor.start(createSession('inspect', {
    inspector: { enabled: true, waitForDebugger: false }
  }))

  assert.match(status.inspectorUrl, /^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+$/u)
  assert.equal(endpoints.length, 1)
  assert.equal(endpoints[0].url, status.inspectorUrl)
  assert.equal(endpoints[0].waitForDebugger, false)
})

test('uses the admitted graph root and reports only a stable internal start stage', async t => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event))
  const entryUrl = 'app+local://workspace/.holonomy/test-entry.mjs'
  const dependencyUrl = 'app+local://workspace/conformance/example.test.mjs'
  const graph = {
    entryUrl,
    runtimeModules: [],
    syntheticModules: {},
    userModules: [{ source: 'import "../conformance/example.test.mjs"', url: entryUrl }, {
      source: 'console.log("GRAPH_ROOT_OK")',
      url: dependencyUrl
    }]
  }

  await assert.rejects(
    supervisor.start({
      entryUrl,
      moduleRootUrl: 'app+local://workspace/',
      runtimeModules: [],
      syntheticModules: {},
      userModules: [{ source: 'throw new Error("PRIVATE_START_DETAIL")', url: entryUrl }]
    }),
    { code: 'start_failed.entry_evaluation' }
  )
  assert.ok(logs.some(event => event.text === 'Node Runtime start failed: entry_evaluation'))
  assert.equal(logs.some(event => event.text.includes('PRIVATE_START_DETAIL')), false)

  await supervisor.stop()
  await supervisor.start({ ...graph, moduleRootUrl: 'app+local://workspace/' })
  assert.ok(logs.some(event => event.text === 'GRAPH_ROOT_OK'))
})

test('terminates an active runtime when its supervisor IPC owner disconnects', async () => {
  const admitted = normalizeNodeRuntimeSession(createSession('owned'))
  const { networkRules: _networkRules, ...wireSession } = admitted
  const session = normalizeNodeRuntimeSession(
    await prepareHolonomyNodeSession({
      ...wireSession,
      runtimeModules: admitted.runtimeModules.map(({ source, url }) => ({ source, url })),
      userModules: admitted.userModules.map(({ source, url }) => ({ source, url }))
    })
  )
  const { networkRules: _runtimeNetworkRules, ...childSession } = session
  const child = fork(new URL('../src/child-runtime.mjs', import.meta.url), [], {
    env: { NODE_NO_WARNINGS: '1' },
    execArgv: ['--experimental-vm-modules', '--max-old-space-size=256'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Node child did not start')), 5_000)
    child.on('message', event => {
      if (event?.type !== 'ack' || event.requestId !== 1) return
      clearTimeout(timer)
      event.ok === true ? resolve() : reject(new Error('Node child rejected start'))
    })
  })
  child.send({
    generation: 1,
    protocolVersion: 1,
    requestId: 1,
    type: 'start',
    value: {
      ...childSession,
      runtimeModules: session.runtimeModules.map(({ source, url }) => ({ source, url })),
      userModules: session.userModules.map(({ source, url }) => ({ source, url }))
    }
  })
  await started
  child.disconnect()
  assert.deepEqual(await exited, { code: 1, signal: null })
})
