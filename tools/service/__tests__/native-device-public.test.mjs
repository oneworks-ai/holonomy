import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

import { createHolonomyServiceLifecycleManager } from '../lifecycle-manager.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const cli = fileURLToPath(new URL('../../holonomy.mjs', import.meta.url))
const guestCase = fileURLToPath(
  new URL('../../../conformance/capabilities/device-native-desktop.test.mjs', import.meta.url)
)
const installation = { implementation: 'builtin.darwin-device-v1' }
const terminalStates = new Set(['cancelled', 'exited', 'failed', 'lost'])

const grant = (maxPrivacyTier, maxPrecision = 'standard') => ({
  access: 'allow',
  maxPrecision,
  maxPrivacyTier
})
const fullPolicy = () => ({
  device: {
    defaultAccess: 'deny',
    maxEventsPerSecond: 20,
    maxQueuedEvents: 8,
    maxSubscriptions: 2,
    operations: {
      'device.display.read': grant(1),
      'device.events.subscribe': grant(1),
      'device.form-factor.read': grant(0),
      'device.input.read': grant(1),
      'device.lifecycle.read': grant(1),
      'device.power.read': grant(1),
      'device.summary.read': grant(1)
    }
  },
  schemaVersion: 2
})
const withOperations = operations => ({
  ...fullPolicy(),
  device: { ...fullPolicy().device, operations }
})

const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-native-device-public-')))
  const home = join(root, 'home')
  const project = join(root, 'project')
  await mkdir(home)
  await mkdir(project)
  if (binary != null) {
    await writeFile(
      join(home, 'native-runtime.json'),
      JSON.stringify({ deviceProvider: installation, executablePath: binary, schemaVersion: 1 }),
      { mode: 0o600 }
    )
  }
  await writeFile(join(project, 'case.mjs'), await readFile(guestCase, 'utf8'))
  await writeFile(
    join(project, 'probe.mjs'),
    `
    import {getDisplay,getFormFactor,getInput,getLifecycle} from 'holo:device'
    console.log('DEVICE_NATIVE_BASELINE:'+JSON.stringify({
      display:getDisplay(),formFactor:getFormFactor(),input:getInput(),lifecycle:getLifecycle()
    }))
  `
  )
  const writeHost = async (name, sandboxPolicy, install = true) => {
    await writeFile(
      join(project, name),
      JSON.stringify({
        ...(install ? { deviceProvider: installation } : {}),
        sandboxPolicy,
        schemaVersion: 1
      })
    )
  }
  await writeHost('host.json', fullPolicy())
  await writeHost('default.json', { schemaVersion: 2 }, false)
  await writeHost('uninstalled.json', fullPolicy(), false)
  await writeHost(
    'summary-only.json',
    withOperations({
      'device.form-factor.read': grant(0),
      'device.summary.read': grant(1)
    })
  )
  await writeHost(
    'coarse.json',
    withOperations({
      ...fullPolicy().device.operations,
      'device.display.read': grant(1, 'coarse')
    })
  )
  await writeHost(
    'higher-field-ceiling.json',
    withOperations({
      ...fullPolicy().device.operations,
      'device.display.read': grant(3)
    })
  )
  await writeFile(
    join(project, 'capability.json'),
    JSON.stringify({
      context: {
        guest: { application: { id: 'native.device.public', name: 'Native Device' } },
        host: {},
        schemaVersion: 1
      },
      initialMiddlewareId: 'service.continue.v1',
      sandboxPolicy: fullPolicy(),
      schemaVersion: 1
    })
  )
  await writeFile(
    join(project, 'default.mjs'),
    `
    import assert from 'node:assert/strict'
    import { getFormFactor, getSummary } from 'holo:device'
    assert.throws(getFormFactor, { code: 'holo.policy_denied' })
    assert.throws(getSummary, { code: 'holo.policy_denied' })
    console.log('DEVICE_DEFAULT_DENY_OK')
  `
  )
  await writeFile(join(project, 'no-install.mjs'), "console.log('DEVICE_UNINSTALLED_ENTRY_RAN')")
  await writeFile(
    join(project, 'summary-only.mjs'),
    `
    import assert from 'node:assert/strict'
    import { getDisplay, getFormFactor, getSummary } from 'holo:device'
    const summary=getSummary()
    assert.equal(summary.schemaVersion,1)
    assert.notEqual(summary.formFactor.status,'unsupported')
    if (summary.formFactor.status==='available') {
      assert.ok(['desktop','unknown'].includes(summary.formFactor.value))
    }
    assert.equal(summary.formFactor.revision,getFormFactor().revision)
    for (const field of ['display','input','lifecycle']) {
      assert.equal(summary[field].status,'permissionDenied')
      assert.equal(summary[field].precision,'none')
      assert.equal(summary[field].revision,0)
      assert.equal(Object.hasOwn(summary[field],'value'),false)
    }
    assert.equal(summary.power.status,'permissionDenied')
    assert.equal(summary.power.revision,0)
    assert.equal(Object.hasOwn(summary.power,'value'),false)
    assert.throws(getDisplay,{code:'holo.policy_denied'})
    console.log('DEVICE_SUMMARY_FIELD_DENY_OK')
  `
  )
  await writeFile(
    join(project, 'coarse.mjs'),
    `
    import assert from 'node:assert/strict'
    import { getDisplay, getSummary } from 'holo:device'
    const direct=getDisplay(), projected=getSummary().display
    for (const reading of [direct,projected]) {
      assert.notEqual(reading.status,'unsupported')
      if (reading.status==='available') {
        assert.equal(reading.precision,'coarse')
        for (const size of [reading.value.widthCssPx,reading.value.heightCssPx]) {
          assert.ok(size===1||size%100===0)
        }
        assert.ok(reading.value.scale===0.25||reading.value.scale*2===Math.round(reading.value.scale*2))
        assert.equal(Object.hasOwn(reading.value,'refreshRateHz'),false)
      }
      else assert.ok(['redacted','unavailable','permissionDenied'].includes(reading.status))
    }
    if (direct.revision===projected.revision) {
      assert.equal(direct.status,projected.status)
      assert.equal(direct.precision,projected.precision)
      assert.deepEqual(direct.value,projected.value)
    }
    console.log('DEVICE_COARSE_POLICY_OK')
  `
  )
  await writeFile(
    join(project, 'higher-field-ceiling.mjs'),
    `
    import assert from 'node:assert/strict'
    import {getDisplay,getSummary} from 'holo:device'
    const summary=getSummary(), direct=getDisplay()
    assert.notEqual(summary.display.status,'permissionDenied')
    assert.notEqual(summary.display.status,'unsupported')
    assert.notEqual(direct.status,'permissionDenied')
    assert.ok(['available','redacted','unavailable'].includes(summary.display.status))
    if (summary.display.revision===direct.revision) {
      assert.equal(summary.display.status,direct.status)
      assert.deepEqual(summary.display.value,direct.value)
    }
    console.log('DEVICE_HIGHER_FIELD_CEILING_OK')
  `
  )
  await writeFile(
    join(project, 'permission.mjs'),
    `
    export default ctx => {
      ctx.holo.intercept({operation:'device.display.read'},
        invocation => ctx.holo.deny(invocation), {execution:'sync'})
    }
  `
  )
  await writeFile(
    join(project, 'holo.config.json'),
    JSON.stringify({
      plugins: [{ id: 'native-device-permission', use: './permission.mjs' }]
    })
  )
  await writeFile(
    join(project, 'plugin-deny.test.mjs'),
    `
    import assert from 'node:assert/strict'
    import {test} from 'node:test'
    import {getDisplay,getFormFactor} from 'holo:device'
    test('Host plugin denies an otherwise selected Device operation',()=>{
      assert.notEqual(getFormFactor().status,'unsupported')
      assert.throws(getDisplay,{code:'holo.permission_denied'})
    })
  `
  )
  await writeFile(
    join(project, 'live.mjs'),
    `
    import {subscribe} from 'holo:device/promises'
    const stream=await subscribe({kinds:['display','lifecycle'],maxQueuedEvents:8})
    const first=(await stream.next()).value
    const second=(await stream.next()).value
    if (first.phase!=='snapshot'||second.phase!=='snapshot') throw Error('missing Device baseline')
    console.log('DEVICE_LIVE_BASELINE:'+stream.generation+':'+first.kind+','+second.kind)
    setInterval(()=>{},1000)
  `
  )
  const client = new HolonomyServiceClient({ home, environment: {} })
  const manager = createHolonomyServiceLifecycleManager({ client, home, service: { port: 0 } })
  return { client, home, manager, project, root }
}

const start = (executable, args, options) => {
  const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = { stderr: '', stdout: '' }
  child.stdout.on('data', bytes => output.stdout += bytes)
  child.stderr.on('data', bytes => output.stderr += bytes)
  const completed = once(child, 'close')
  void completed.catch(() => undefined)
  return { child, completed, output }
}
const finish = async (running, timeoutMs = 30_000) => {
  const timer = setTimeout(() => running.child.kill('SIGKILL'), timeoutMs)
  try {
    const [code, signal] = await running.completed
    return { code, signal, ...running.output }
  } finally {
    clearTimeout(timer)
  }
}
const direct = (f, command, host, entry) =>
  start(binary, [command, '--timeout', '20000', '--host-config', host, entry], {
    cwd: f.project,
    env: { PATH: '' }
  })
const managed = (f, url, command, entry, extra = []) =>
  start(process.execPath, [
    cli,
    command,
    entry,
    '--target',
    'native',
    '--capability-runtime',
    'capability.json',
    '--openapi',
    `${url}/openapi.json`,
    '--openapi-token-file',
    join(f.home, 'token'),
    ...extra
  ], { cwd: f.project, env: { ...process.env, HOLONOMY_HOME: f.home } })
const until = async (read, accepts, label) => {
  let latest
  for (let turn = 0; turn < 1000; turn++) {
    latest = await read()
    if (accepts(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`${label} did not settle: ${JSON.stringify(latest)}`)
}
const serviceReport = output =>
  output.split('\n').map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).find(value => value?.total === 5 && Array.isArray(value.results))
const cleanProcess = async (f, id) => {
  const current = await f.client.getProcess(id)
  if (!terminalStates.has(current.state)) {
    const stop = await f.client.processAction(id, 'stop', current.generation, randomUUID())
    await until(
      () => f.client.getOperation(stop.value.operation.id),
      value => ['succeeded', 'failed'].includes(value.state),
      'Native Device stop'
    )
  }
  const terminal = await until(
    () => f.client.getProcess(id),
    value => terminalStates.has(value.state) && value.cleanupPending !== true,
    'Native Device terminal'
  )
  await f.client.removeProcess(id, terminal.generation, randomUUID())
}
const cleanOwned = async (f, owned) => {
  for (const record of await f.client.call('/v1/processes').catch(() => [])) owned.add(record.id)
  for (const id of owned) await cleanProcess(f, id)
}

describe('public Native desktop Device installation', () => {
  it.skipIf(process.platform !== 'darwin')(
    'runs the same Guest conformance in standalone Rust/V8 and managed Service Native',
    async () => {
      assert(binary, 'HOLONOMY_NATIVE_TEST_EXECUTABLE must point to the real Native binary')
      const f = await fixture()
      const owned = new Set()
      let serviceStarted = false
      try {
        const standalone = await finish(direct(f, 'test', 'host.json', './case.mjs'))
        assert.equal(standalone.code, 0, standalone.stderr + standalone.stdout)
        const report = JSON.parse(standalone.stdout.trim())
        assert.deepEqual([report.total, report.passed, report.failed], [5, 5, 0])
        const liveProbe = await finish(direct(f, 'run', 'host.json', './probe.mjs'))
        assert.equal(liveProbe.code, 0, liveProbe.stderr + liveProbe.stdout)
        assert.match(liveProbe.stdout, /DEVICE_NATIVE_BASELINE:/u)

        const service = await f.manager.ensure()
        serviceStarted = true
        const managedTest = await finish(managed(
          f,
          service.endpoint.baseUrl,
          'test',
          './case.mjs',
          ['--reporter', 'json']
        ))
        assert.equal(managedTest.code, 0, managedTest.stderr + managedTest.stdout)
        const managedReport = serviceReport(managedTest.stdout)
        assert(managedReport, managedTest.stdout)
        assert.deepEqual([managedReport.total, managedReport.passed, managedReport.failed], [5, 5, 0])
        const processes = await f.client.call('/v1/processes')
        const publicSnapshot = JSON.stringify(processes)
        assert.equal(publicSnapshot.includes('builtin.darwin-device-v1'), false)
        assert.equal(publicSnapshot.includes(f.root), false)
        for (const processRecord of processes) {
          owned.add(processRecord.id)
          assert.equal(processRecord.exit?.code, 0, JSON.stringify(processRecord))
        }
      } finally {
        try {
          if (serviceStarted) await cleanOwned(f, owned)
        } finally {
          try {
            await f.manager.stop({ drain: true })
          } finally {
            await rm(f.root, { recursive: true, force: true })
          }
        }
      }
    },
    45_000
  )

  it.skipIf(process.platform !== 'darwin')(
    'denies by default, requires owner installation, and keeps summary fields independently gated',
    async () => {
      assert(binary, 'HOLONOMY_NATIVE_TEST_EXECUTABLE must point to the real Native binary')
      const f = await fixture()
      try {
        const denied = await finish(direct(f, 'run', 'default.json', './default.mjs'))
        assert.equal(denied.code, 0, denied.stderr + denied.stdout)
        assert.match(denied.stdout, /DEVICE_DEFAULT_DENY_OK/u)

        const uninstalled = await finish(direct(f, 'run', 'uninstalled.json', './no-install.mjs'))
        assert.notEqual(uninstalled.code, 0)
        assert.doesNotMatch(uninstalled.stdout, /DEVICE_UNINSTALLED_ENTRY_RAN/u)

        const partial = await finish(direct(f, 'run', 'summary-only.json', './summary-only.mjs'))
        assert.equal(partial.code, 0, partial.stderr + partial.stdout)
        assert.match(partial.stdout, /DEVICE_SUMMARY_FIELD_DENY_OK/u)

        const coarse = await finish(direct(f, 'run', 'coarse.json', './coarse.mjs'))
        assert.equal(coarse.code, 0, coarse.stderr + coarse.stdout)
        assert.match(coarse.stdout, /DEVICE_COARSE_POLICY_OK/u)

        const largerField = await finish(direct(f, 'run', 'higher-field-ceiling.json', './higher-field-ceiling.mjs'))
        assert.equal(largerField.code, 0, largerField.stderr + largerField.stdout)
        assert.match(largerField.stdout, /DEVICE_HIGHER_FIELD_CEILING_OK/u)
      } finally {
        try {
          await f.manager.stop({ drain: true })
        } finally {
          await rm(f.root, { recursive: true, force: true })
        }
      }
    },
    45_000
  )

  it.skipIf(process.platform !== 'darwin')(
    'keeps plugin denial and Service stop/restart within the selected Native generation',
    async () => {
      assert(binary, 'HOLONOMY_NATIVE_TEST_EXECUTABLE must point to the real Native binary')
      const f = await fixture()
      const owned = new Set()
      let serviceStarted = false
      try {
        const service = await f.manager.ensure()
        serviceStarted = true
        const denied = await finish(managed(
          f,
          service.endpoint.baseUrl,
          'test',
          './plugin-deny.test.mjs',
          ['--config', 'holo.config.json', '--reporter', 'json']
        ))
        assert.equal(denied.code, 0, denied.stderr + denied.stdout)
        const result = denied.stdout.split('\n').map(line => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        }).find(value => value?.total === 1 && Array.isArray(value.results))
        assert(result, denied.stdout)
        assert.deepEqual([result.passed, result.failed], [1, 0])

        const launched = await finish(managed(
          f,
          service.endpoint.baseUrl,
          'run',
          './live.mjs',
          ['--detach']
        ))
        assert.equal(launched.code, 0, launched.stderr + launched.stdout)
        const id = JSON.parse(launched.stdout).processId
        owned.add(id)
        const first = await until(
          () => f.client.readLogs(id, { after: 0, limit: 256 }),
          value => value.events.some(event => event.chunk.includes('DEVICE_LIVE_BASELINE:1:display,lifecycle')),
          'generation one Device baseline'
        )
        assert(first.events.some(event => event.chunk.includes('DEVICE_LIVE_BASELINE:1:display,lifecycle')))
        const current = await f.client.getProcess(id)
        const restarted = await f.client.processAction(id, 'restart', current.generation, randomUUID())
        await until(
          () => f.client.getOperation(restarted.value.operation.id),
          value => value.state === 'succeeded',
          'Native Device restart'
        )
        const next = await until(
          () => f.client.getProcess(id),
          value => value.generation === current.generation + 1,
          'new Native Device generation'
        )
        await until(
          () => f.client.readLogs(id, { after: first.cursor, limit: 256 }),
          value => value.events.some(event => event.chunk.includes('DEVICE_LIVE_BASELINE:1:display,lifecycle')),
          'generation two Device baseline'
        )
        const stop = await f.client.processAction(id, 'stop', next.generation, randomUUID())
        await until(
          () => f.client.getOperation(stop.value.operation.id),
          value => value.state === 'succeeded',
          'Native Device stop'
        )
        const ended = await until(
          () => f.client.getProcess(id),
          value => terminalStates.has(value.state) && value.cleanupPending !== true,
          'Native Device cleanup'
        )
        assert.equal(ended.generation, next.generation)
        for (const processRecord of await f.client.call('/v1/processes')) owned.add(processRecord.id)
      } finally {
        try {
          if (serviceStarted) await cleanOwned(f, owned)
        } finally {
          try {
            await f.manager.stop({ drain: true })
          } finally {
            await rm(f.root, { recursive: true, force: true })
          }
        }
      }
    },
    60_000
  )
})
