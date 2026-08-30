/* eslint-disable max-lines -- This file is the end-to-end Runtime capability acceptance sequence. */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { normalizeNodeRuntimeSession } from '../src/session-validation.mjs'
import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { capabilityRuntimeSession } from './capability-runtime-fixture.mjs'
import { systemInformationPolicy, systemProjection } from './capability-runtime-system-fixture.mjs'

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
      import { getFormFactor, getLifecycle, getSummary } from 'holo:device'
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
        device: {
          formFactor: getFormFactor(),
          lifecycle: getLifecycle(),
          summary: getSummary()
        },
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
    device: {
      formFactor: { observedAt: 100, precision: 'standard', revision: 1, status: 'available', value: 'server' },
      lifecycle: {
        observedAt: 100,
        precision: 'standard',
        revision: 1,
        status: 'available',
        value: { interactive: true, memoryPressure: 'normal', visibility: 'foreground' }
      },
      summary: {
        display: { observedAt: 100, precision: 'none', revision: 1, status: 'unsupported' },
        formFactor: { observedAt: 100, precision: 'standard', revision: 1, status: 'available', value: 'server' },
        input: { observedAt: 100, precision: 'none', revision: 1, status: 'unsupported' },
        lifecycle: {
          observedAt: 100,
          precision: 'standard',
          revision: 1,
          status: 'available',
          value: { interactive: true, memoryPressure: 'normal', visibility: 'foreground' }
        },
        power: { observedAt: 100, precision: 'none', revision: 1, status: 'unsupported' },
        schemaVersion: 1
      }
    },
    promiseValue: 'input-from-host',
    syncValue: 'input-from-host',
    writeCallbackArity: 1
  })
})

test('projects every declared Host System field and node:process identity through the Broker', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-system-m3-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  const conformanceUrl = 'app+local://workspace/conformance/system-projection.test.mjs'
  const conformanceSource = await readFile(
    new URL('../../../conformance/capabilities/system-projection.test.mjs', import.meta.url),
    'utf8'
  )

  await supervisor.start(capabilityRuntimeSession({
    additionalUserModules: [{ source: conformanceSource, url: conformanceUrl }],
    entryUrl,
    hostPath: root,
    moduleRootUrl,
    source: `
      import ${JSON.stringify(conformanceUrl)}
      import { run as runTests } from 'node:test'
      const summary = await runTests()
      if (summary.failed !== 0) throw new Error('Host System Guest conformance failed')
      console.log('CAPABILITY_SYSTEM_M3:' + JSON.stringify(summary))
    `,
    systemInformation: systemInformationPolicy,
    systemProjection
  }))

  const result = JSON.parse(logs.find(value => value.startsWith('CAPABILITY_SYSTEM_M3:')).slice(21))
  assert.equal(result.failed, 0)
  assert.equal(result.passed, 1)
  assert.equal(result.total, 1)
})

test('runs the shared Filesystem Provider v1 conformance through the Node Runtime', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-fs-shared-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  const conformanceUrl = 'app+local://workspace/conformance/filesystem-v1.test.mjs'
  const conformanceSource = await readFile(
    new URL('../../../conformance/capabilities/filesystem-v1.test.mjs', import.meta.url),
    'utf8'
  )

  await supervisor.start(capabilityRuntimeSession({
    additionalUserModules: [{ source: conformanceSource, url: conformanceUrl }],
    entryUrl,
    hostPath: root,
    moduleRootUrl,
    source: `
      import ${JSON.stringify(conformanceUrl)}
      import { run as runTests } from 'node:test'
      const summary = await runTests()
      console.log('CAPABILITY_FS_SHARED:' + JSON.stringify(summary))
      if (summary.failed !== 0) throw new Error('Filesystem Provider v1 Guest conformance failed')
    `
  }))

  const result = JSON.parse(logs.find(value => value.startsWith('CAPABILITY_FS_SHARED:')).slice(21))
  assert.equal(result.failed, 0)
  assert.equal(result.passed, 6)
  assert.equal(result.total, 6)
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

test('propagates filesystem AbortSignal without exposing the Guest object to the Host', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-fs-abort-'))
  await writeFile(path.join(root, 'input.txt'), 'input')
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
      import { readFile as readFileCallback } from 'node:fs'
      import { readFile, writeFile } from 'node:fs/promises'

      const promiseController = new AbortController()
      promiseController.abort()
      let promiseError
      try {
        await readFile('holo-fs://workspace/input.txt', { encoding: 'utf8', signal: promiseController.signal })
      } catch (error) {
        promiseError = { code: error.code, name: error.name }
      }

      const writeController = new AbortController()
      writeController.abort()
      let writeError
      try {
        await writeFile('holo-fs://workspace/aborted.txt', 'must-not-exist', { signal: writeController.signal })
      } catch (error) {
        writeError = { code: error.code, name: error.name }
      }

      const callbackController = new AbortController()
      callbackController.abort()
      let callbackCalls = 0
      const callbackError = await new Promise(resolve => {
        readFileCallback(
          'holo-fs://workspace/input.txt',
          { encoding: 'utf8', signal: callbackController.signal },
          function(error) {
            callbackCalls += 1
            resolve({ args: arguments.length, code: error.code, name: error.name })
          }
        )
      })
      console.log('CAPABILITY_FS_ABORT:' + JSON.stringify({
        callbackCalls,
        callbackError,
        promiseError,
        writeError
      }))
    `
  }))

  assert.deepEqual(
    JSON.parse(logs.find(value => value.startsWith('CAPABILITY_FS_ABORT:')).slice(20)),
    {
      callbackCalls: 1,
      callbackError: { args: 1, code: 'ABORT_ERR', name: 'AbortError' },
      promiseError: { code: 'ABORT_ERR', name: 'AbortError' },
      writeError: { code: 'ABORT_ERR', name: 'AbortError' }
    }
  )
  await assert.rejects(readFile(path.join(root, 'aborted.txt')), { code: 'ENOENT' })
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
      let queueLimitError
      try {
        watch('holo-fs://workspace/', { maxQueuedEvents: 9, persistent: false }, () => {})
      } catch (error) {
        queueLimitError = error.code
      }
      const result = await new Promise((resolve, reject) => {
        const watcher = watch(
          'holo-fs://workspace/',
          { maxQueuedEvents: 1, persistent: false },
          function(type, filename) {
          let closeError
          try {
            watcher.close()
          } catch (error) {
            closeError = { code: error.code, message: error.message }
          }
          if (closeError) console.log('CAPABILITY_WATCH_CLOSE_ERROR:' + JSON.stringify(closeError))
            resolve({ filename, maxQueuedEvents: watcher.maxQueuedEvents, queueLimitError, type })
          }
        )
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
  assert.equal(event.maxQueuedEvents, 1)
  assert.equal(event.queueLimitError, 'EINVAL')
  assert.ok(['change', 'rename'].includes(event.type))
})

test('closes generation-one filesystem resources before restart admits generation two', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-watch-restart-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push({ generation: event.generation, text: event.text }))
  const source = `
    import { watch } from 'node:fs'
    watch('holo-fs://workspace/', { persistent: false }, () => console.log('FS_GENERATION_EVENT'))
    console.log('FS_GENERATION_READY')
  `
  await supervisor.start(capabilityRuntimeSession({
    entryUrl,
    hostPath: root,
    moduleRootUrl,
    source
  }))
  await waitFor(() => logs.find(event => event.generation === 1 && event.text === 'FS_GENERATION_READY'))
  await supervisor.restart(capabilityRuntimeSession({
    entryUrl,
    hostPath: root,
    moduleRootUrl,
    source
  }))
  await waitFor(() => logs.find(event => event.generation === 2 && event.text === 'FS_GENERATION_READY'))
  await writeFile(path.join(root, 'after-restart.txt'), 'generation-two')
  await waitFor(() => logs.find(event => event.generation === 2 && event.text === 'FS_GENERATION_EVENT'))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(logs.some(event => event.generation === 1 && event.text === 'FS_GENERATION_EVENT'), false)
})

test('re-authorizes within-root symlinks through resolved Host middleware', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-symlink-m3-'))
  await writeFile(path.join(root, 'target.txt'), 'target-value')
  await symlink(path.join(root, 'target.txt'), path.join(root, 'link.txt'))
  t.after(() => rm(root, { force: true, recursive: true }))

  const allowed = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  const allowedLogs = []
  allowed.on('log', event => allowedLogs.push(event.text))
  t.after(() => allowed.stop())
  await allowed.start(capabilityRuntimeSession({
    entryUrl,
    filesystemSymlinks: 'withinRoot',
    hostPath: root,
    moduleRootUrl,
    source: `
      import { readFileSync } from 'node:fs'
      console.log('SYMLINK_ALLOW:' + readFileSync('holo-fs://workspace/link.txt', 'utf8'))
    `
  }))
  assert.ok(allowedLogs.includes('SYMLINK_ALLOW:target-value'))
  await allowed.stop()

  const denied = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  const deniedLogs = []
  denied.on('log', event => deniedLogs.push(event.text))
  t.after(() => denied.stop())
  await denied.start(capabilityRuntimeSession({
    behavior: 'deny',
    entryUrl,
    filesystemSymlinks: 'withinRoot',
    hostPath: root,
    middlewareMatcher: { phase: 'resolved' },
    moduleRootUrl,
    source: `
      import { readFileSync } from 'node:fs'
      const direct = readFileSync('holo-fs://workspace/target.txt', 'utf8')
      let symlinkCode
      try { readFileSync('holo-fs://workspace/link.txt', 'utf8') } catch (error) { symlinkCode = error.code }
      console.log('SYMLINK_RESOLUTION:' + JSON.stringify({ direct, symlinkCode }))
    `
  }))
  const result = JSON.parse(deniedLogs.find(value => value.startsWith('SYMLINK_RESOLUTION:')).slice(19))
  assert.deepEqual(result, { direct: 'target-value', symlinkCode: 'EACCES' })
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
      import { getDisplay, getFormFactor, getInput, getLifecycle, getSummary } from 'holo:device'
      import { getSummary as getSummaryPromise, subscribe } from 'holo:device/promises'
      const subscription = await subscribe({ kinds: ['display', 'lifecycle'] })
      const events = [(await subscription.next()).value, (await subscription.next()).value]
      await subscription.close()
      const bounded = await subscribe({ kinds: ['display', 'lifecycle'], maxQueuedEvents: 1 })
      const overflow = (await bounded.next()).value
      let invalidAck
      try {
        await bounded.acknowledgeResync({
          display: getDisplay().revision + 1,
          lifecycle: getLifecycle().revision
        })
      } catch (error) {
        invalidAck = error.code
      }
      await bounded.acknowledgeResync({
        display: getDisplay().revision,
        lifecycle: getLifecycle().revision
      })
      await bounded.close()
      console.log('CAPABILITY_DEVICE_M3:' + JSON.stringify({
        events,
        invalidAck,
        maxQueuedEvents: bounded.maxQueuedEvents,
        overflow,
        readings: {
          display: getDisplay(),
          formFactor: getFormFactor(),
          input: getInput(),
          lifecycle: getLifecycle(),
          summary: getSummary(),
          summaryPromise: await getSummaryPromise()
        },
        startSequence: subscription.startSequence
      }))
    `
  }))

  const result = JSON.parse(logs.find(value => value.startsWith('CAPABILITY_DEVICE_M3:')).slice(21))
  assert.deepEqual(result.events.map(event => event.kind), ['display', 'lifecycle'])
  assert.ok(result.events.every(event => event.phase === 'snapshot'))
  assert.ok(['display', 'formFactor', 'input', 'lifecycle'].every(name => result.readings[name].status === 'available'))
  assert.equal(result.readings.display.value.widthCssPx, 1440)
  assert.equal(result.readings.formFactor.value, 'desktop')
  assert.equal(result.readings.input.value.pointer, 'fine')
  assert.equal(result.readings.lifecycle.value.visibility, 'foreground')
  assert.deepEqual(result.readings.summaryPromise, result.readings.summary)
  assert.equal(result.invalidAck, 'holo.invalid_arguments')
  assert.equal(result.maxQueuedEvents, 1)
  assert.equal(result.overflow.kind, 'overflow')
  assert.deepEqual(result.overflow.requiredRevisions, { display: 1, lifecycle: 1 })
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
    try {
      await supervisor.start(capabilityRuntimeSession({
        entryUrl,
        hostPath: root,
        moduleRootUrl,
        network: scenario.network,
        source: `
          try {
            const response = await fetch(${JSON.stringify(scenario.url)})
            console.log('CAPABILITY_FETCH:' + await response.text())
          } catch (error) {
            console.error('CAPABILITY_FETCH_ERROR:' + JSON.stringify({
              code: error?.code,
              message: error?.message,
              name: error?.name
            }))
            throw error
          }
        `
      }))
    } catch (error) {
      t.diagnostic(logs.join('\n'))
      throw error
    }
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

test('runs redirect, cloned body, cancellation and fixed WebSocket support through the Node Runtime', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-capability-network-continuation-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  const origin = 'https://api.example'
  const rules = {
    mode: 'failClosed',
    rules: [{
      action: { headers: [['location', `${origin}/redirected`]], status: 302, type: 'respond' },
      id: 'redirect',
      match: { method: 'GET', origin, path: { op: 'exact', value: '/redirect' } },
      priority: 3
    }, {
      action: { body: { kind: 'utf8', value: 'redirected' }, status: 200, type: 'respond' },
      id: 'redirected',
      match: { method: 'GET', origin, path: { op: 'exact', value: '/redirected' } },
      priority: 2
    }, {
      action: { body: { kind: 'utf8', value: 'late' }, delayMs: 1_000, status: 200, type: 'respond' },
      id: 'slow',
      match: { method: 'GET', origin, path: { op: 'exact', value: '/slow' } },
      priority: 1
    }]
  }

  await supervisor.start(capabilityRuntimeSession({
    entryUrl,
    hostPath: root,
    moduleRootUrl,
    network: { access: 'mockOnly', origin, rules },
    source: `
      const redirected = await fetch('${origin}/redirect')
      const clone = redirected.clone()
      const first = await redirected.text()
      const second = await clone.text()
      console.log('CAPABILITY_CONTINUATION:' + first + ':' + second + ':' + redirected.redirected)

      const controller = new AbortController()
      const cancelled = fetch('${origin}/slow', { signal: controller.signal })
      setTimeout(() => controller.abort(), 10)
      try {
        await cancelled
        console.log('CAPABILITY_CANCEL:unexpected')
      } catch (error) {
        console.log('CAPABILITY_CANCEL:' + String(error?.code ?? 'unknown'))
      }

      try {
        new WebSocket('wss://api.example/socket')
        console.log('CAPABILITY_WEBSOCKET:unexpected')
      } catch (error) {
        console.log('CAPABILITY_WEBSOCKET:' + error.name + ':' + error.message)
      }
    `
  }))

  await waitFor(() => logs.find(value => value === 'CAPABILITY_CONTINUATION:redirected:redirected:true'))
  await waitFor(() => logs.find(value => value === 'CAPABILITY_CANCEL:network.cancelled'))
  await waitFor(() =>
    logs.find(value => (
      value === 'CAPABILITY_WEBSOCKET:TypeError:Holonomy WebSocket is unsupported by SandboxPolicyV2'
    ))
  )
  assert.equal(logs.some(value => value.endsWith(':unexpected')), false)
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
