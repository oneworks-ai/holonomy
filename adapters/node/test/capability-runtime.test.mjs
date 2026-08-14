import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { normalizeNodeRuntimeSession } from '../src/session-validation.mjs'
import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { capabilityRuntimeSession } from './capability-runtime-fixture.mjs'

const entryUrl = 'app+local://workspace/main.mjs'
const moduleRootUrl = 'app+local://workspace/'
const listen = server =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address())
    })
  })
const close = server => new Promise(resolve => server.close(resolve))

test('runs Node filesystem, system, device and Runtime Context through one admitted Broker', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-node-'))
  await writeFile(path.join(root, 'input.txt'), 'input-from-host')
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))

  await supervisor.start(capabilityRuntimeSession({
    entryUrl,
    hostPath: root,
    moduleRootUrl,
    source: `
      import { readFile, readFileSync, writeFile } from 'node:fs'
      import { readFile as readFilePromise } from 'node:fs/promises'
      import { arch } from 'node:os'
      import { getFormFactor } from 'holo:device'
      import { getContext } from 'holo:runtime'

      const callbackValue = await new Promise((resolve, reject) => {
        readFile('holo-fs://workspace/input.txt', 'utf8', (error, value) => error ? reject(error) : resolve(value))
      })
      const writeCallbackArity = await new Promise((resolve, reject) => {
        writeFile('holo-fs://workspace/output.txt', 'written-by-guest', 'utf8', function(error) {
          if (error) reject(error)
          else resolve(arguments.length)
        })
      })
      const context = getContext()
      console.log(JSON.stringify({
        arch: arch(),
        callbackValue,
        context,
        contextFrozen: Object.isFrozen(context) && Object.isFrozen(context.application),
        device: getFormFactor(),
        promiseValue: await readFilePromise('holo-fs://workspace/input.txt', 'utf8'),
        syncValue: readFileSync('holo-fs://workspace/input.txt', 'utf8'),
        writeCallbackArity
      }))
    `
  }))

  assert.equal(await readFile(path.join(root, 'output.txt'), 'utf8'), 'written-by-guest')
  const output = JSON.parse(logs.find(value => value.startsWith('{')))
  assert.deepEqual(output, {
    arch: 'arm64',
    callbackValue: 'input-from-host',
    context: { application: { id: 'example.guest', name: 'Example Guest' } },
    contextFrozen: true,
    device: { observedAt: 100, precision: 'standard', revision: 1, status: 'available', value: 'desktop' },
    promiseValue: 'input-from-host',
    syncValue: 'input-from-host',
    writeCallbackArity: 1
  })
})

test('runs the declared Node filesystem resource and metadata surface through the Broker', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-fs-m3-'))
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 255]))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))

  await supervisor.start(capabilityRuntimeSession({
    entryUrl,
    hostPath: root,
    moduleRootUrl,
    source: `
      import {
        closeSync,
        lstatSync,
        mkdirSync,
        openSync,
        readFileSync,
        readdirSync,
        renameSync,
        statSync,
        unlinkSync,
        writeFileSync
      } from 'node:fs'
      import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
      import { Buffer } from 'node:buffer'

      const directory = mkdirSync('holo-fs://workspace/nested/deep', { recursive: true })
      writeFileSync('holo-fs://workspace/nested/deep/text.txt', Buffer.from([104, 105]))
      const fd = openSync('holo-fs://workspace/nested/deep/text.txt', 'r')
      const fdText = readFileSync(fd, 'utf8')
      closeSync(fd)
      const handle = await open('holo-fs://workspace/nested/deep/text.txt', 'r+')
      await handle.writeFile('updated')
      const handleStat = await handle.stat()
      await handle.close()
      await writeFile('holo-fs://workspace/promise.txt', 'promise')
      await rename('holo-fs://workspace/promise.txt', 'holo-fs://workspace/renamed.txt')
      const promiseStat = await stat('holo-fs://workspace/renamed.txt')
      const promiseText = await readFile('holo-fs://workspace/renamed.txt', 'utf8')
      await unlink('holo-fs://workspace/renamed.txt')
      renameSync('holo-fs://workspace/nested/deep/text.txt', 'holo-fs://workspace/nested/deep/moved.txt')
      const names = readdirSync('holo-fs://workspace/nested/deep')
      const dirents = readdirSync('holo-fs://workspace/nested/deep', { withFileTypes: true })
      const binary = readFileSync('holo-fs://workspace/binary.bin')
      const linkStat = lstatSync('holo-fs://workspace/nested/deep/moved.txt')
      unlinkSync('holo-fs://workspace/nested/deep/moved.txt')
      console.log('CAPABILITY_FS_M3:' + JSON.stringify({
        binary: Array.from(binary),
        directory,
        dirents: dirents.map(item => [item.name, item.isFile()]),
        fdText,
        handleSize: handleStat.size,
        linkFile: linkStat.isFile(),
        names,
        promiseFile: promiseStat.isFile(),
        promiseText
      }))
    `
  }))

  assert.deepEqual(JSON.parse(logs.find(value => value.startsWith('CAPABILITY_FS_M3:')).slice(17)), {
    binary: [0, 1, 2, 255],
    directory: 'holo-fs://workspace/nested',
    dirents: [['moved.txt', true]],
    fdText: 'hi',
    handleSize: 7,
    linkFile: true,
    names: ['moved.txt'],
    promiseFile: true,
    promiseText: 'promise'
  })
})

test('streams filesystem watch events through the generation-bound resource registry', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-watch-m3-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))

  await supervisor.start(capabilityRuntimeSession({
    entryUrl,
    hostPath: root,
    moduleRootUrl,
    source: `
      import { watch, writeFileSync } from 'node:fs'
      const result = await new Promise((resolve, reject) => {
        const watcher = watch('holo-fs://workspace/', { persistent: false }, function(type, filename) {
          let closeError
          try {
            watcher.close()
          } catch (error) {
            closeError = { code: error.code, message: error.message }
          }
          if (closeError) console.log('CAPABILITY_WATCH_CLOSE_ERROR:' + JSON.stringify(closeError))
          resolve({ filename, type })
        })
        watcher.on('error', reject)
        setTimeout(() => writeFileSync('holo-fs://workspace/watched.txt', 'changed'), 20)
      })
      console.log('CAPABILITY_WATCH_M3:' + JSON.stringify(result))
      `
  }))

  const event = JSON.parse(logs.find(value => value.startsWith('CAPABILITY_WATCH_M3:')).slice(20))
  const closeFailure = logs.find(value => value.startsWith('CAPABILITY_WATCH_CLOSE_ERROR:'))
  assert.equal(closeFailure, undefined)
  assert.equal(event.filename, 'watched.txt')
  assert.ok(['change', 'rename'].includes(event.type))
})

test('streams required Device snapshot events through a generation-bound subscription', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-device-m3-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))

  await supervisor.start(capabilityRuntimeSession({
    deviceTarget: 'desktop',
    entryUrl,
    hostPath: root,
    moduleRootUrl,
    source: `
      import { getSummary, subscribe } from 'holo:device/promises'
      const subscription = await subscribe({ kinds: ['lifecycle'] })
      const first = await subscription.next()
      await subscription.close()
      console.log('CAPABILITY_DEVICE_M3:' + JSON.stringify({
        first,
        summary: await getSummary(),
        startSequence: subscription.startSequence
      }))
    `
  }))

  const result = JSON.parse(logs.find(value => value.startsWith('CAPABILITY_DEVICE_M3:')).slice(21))
  assert.equal(result.first.done, false)
  assert.equal(result.first.value.kind, 'lifecycle')
  assert.equal(result.first.value.phase, 'snapshot')
  assert.equal(result.summary.lifecycle.value.visibility, 'foreground')
  assert.equal(result.startSequence, 0)
})

test('fails initial capability admission before Guest entry side effects', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-admission-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  const session = capabilityRuntimeSession({
    entryUrl,
    hostPath: root,
    moduleRootUrl,
    source: 'console.log("ENTRY_SIDE_EFFECT")'
  })
  session.capabilityRuntime.runtimeCreation.hostBindings.engineGate.ownerId = 'wrong-owner'

  await assert.rejects(supervisor.start(session), { code: 'start_failed.host_bridge' })
  assert.equal(logs.includes('ENTRY_SIDE_EFFECT'), false)
})

test('authorizes real and mock Fetch through the same Broker without widening providers', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-network-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  let realRequests = 0
  const server = createServer((_request, response) => {
    realRequests += 1
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('real-provider')
  })
  const address = await listen(server)
  t.after(() => close(server))
  assert.equal(typeof address, 'object')
  const realOrigin = `http://127.0.0.1:${address.port}`

  for (
    const scenario of [{
      expected: 'real-provider',
      network: {
        access: 'restricted',
        origin: realOrigin,
        privateNetwork: true,
        rules: { mode: 'passthrough', rules: [] }
      },
      url: `${realOrigin}/profile`
    }, {
      expected: 'mock-provider',
      network: {
        access: 'mockOnly',
        origin: 'https://api.example',
        rules: {
          mode: 'failClosed',
          rules: [{
            action: { body: { kind: 'utf8', value: 'mock-provider' }, status: 200, type: 'respond' },
            id: 'mock-profile',
            match: { method: 'GET', path: { op: 'exact', value: '/profile' } },
            priority: 1
          }]
        }
      },
      url: 'https://api.example/profile'
    }]
  ) {
    const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
    t.after(() => supervisor.stop())
    const logs = []
    supervisor.on('log', event => logs.push(event.text))
    await supervisor.start(capabilityRuntimeSession({
      entryUrl,
      hostPath: root,
      moduleRootUrl,
      network: scenario.network,
      source: `
        const response = await fetch(${JSON.stringify(scenario.url)})
        console.log('CAPABILITY_FETCH:' + await response.text())
      `
    }))
    assert.ok(logs.includes(`CAPABILITY_FETCH:${scenario.expected}`))
    await supervisor.stop()
  }
  assert.equal(realRequests, 1)
})

test('rejects a capability network authority that differs from the Node transport', () => {
  const session = capabilityRuntimeSession({
    entryUrl,
    hostPath: os.tmpdir(),
    moduleRootUrl,
    network: {
      access: 'restricted',
      origin: 'https://api.example',
      rules: { mode: 'passthrough', rules: [] }
    },
    source: 'export {}'
  })
  session.capabilityRuntime.runtimeCreation.configuration.sandboxPolicy.network.limits.maxResponseBodyBytes *= 2

  assert.throws(() => normalizeNodeRuntimeSession(session), /capability Runtime session/u)

  const providerMismatch = capabilityRuntimeSession({
    entryUrl,
    hostPath: os.tmpdir(),
    moduleRootUrl,
    network: {
      access: 'restricted',
      origin: 'https://api.example',
      rules: { mode: 'passthrough', rules: [] }
    },
    source: 'export {}'
  })
  providerMismatch.capabilityRuntime.providerConfiguration.networkProvider = 'host.network.mock'
  assert.throws(() => normalizeNodeRuntimeSession(providerMismatch), /capability Runtime session/u)
})

test('delivers stable middleware denial, failure and timeout exactly once', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-errors-'))
  await writeFile(path.join(root, 'input.txt'), 'never-readable')
  t.after(() => rm(root, { force: true, recursive: true }))
  for (
    const [behavior, expectedCode] of [
      ['deny', 'EACCES'],
      ['throw', 'EIO'],
      ['timeout', 'ETIMEDOUT']
    ]
  ) {
    const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
    t.after(() => supervisor.stop())
    const logs = []
    supervisor.on('log', event => logs.push(event.text))
    await supervisor.start(capabilityRuntimeSession({
      behavior,
      entryUrl,
      hostPath: root,
      moduleRootUrl,
      source: `
        import { readFile } from 'node:fs'
        let calls = 0
        await new Promise(resolve => {
          readFile('holo-fs://workspace/input.txt', 'utf8', function(error) {
            calls += 1
            console.log('CAPABILITY_ERROR:' + JSON.stringify({
              args: arguments.length,
              calls,
              code: error && error.code,
              name: error && error.name
            }))
            resolve()
          })
        })
      `
    }))
    const result = JSON.parse(logs.find(value => value.startsWith('CAPABILITY_ERROR:')).slice(17))
    assert.deepEqual(result, { args: 1, calls: 1, code: expectedCode, name: 'Error' })
    await supervisor.stop()
  }
})

test('re-admits a fresh immutable Runtime snapshot on restart', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-restart-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push({ generation: event.generation, text: event.text }))
  const source = `
    import { getContext } from 'holo:runtime'
    console.log('CAPABILITY_GENERATION:' + JSON.stringify(getContext()))
  `
  const first = capabilityRuntimeSession({ entryUrl, hostPath: root, moduleRootUrl, source })
  await supervisor.start(first)
  const second = capabilityRuntimeSession({ entryUrl, hostPath: root, moduleRootUrl, source })
  second.capabilityRuntime.runtimeCreation.configuration.context.guest.application.id = 'example.restart'
  await supervisor.restart(second)

  assert.deepEqual(
    logs.filter(event => event.text.startsWith('CAPABILITY_GENERATION:')).map(event => ({
      generation: event.generation,
      value: JSON.parse(event.text.slice(22)).application.id
    })),
    [
      { generation: 1, value: 'example.guest' },
      { generation: 2, value: 'example.restart' }
    ]
  )
})
