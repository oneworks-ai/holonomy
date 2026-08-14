import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { NodeProcessProviderV1 } from '../src/capability-process-provider.mjs'

const executableResource = Object.freeze({
  environmentScope: 'processTree',
  executableId: 'tool',
  invocation: 'program',
  kind: 'processExecutable',
  semanticResourceDigest: '1'.repeat(64)
})
const context = (operation, argumentsValue, requested, inheritedBindingId, callbackId) => ({
  arguments: argumentsValue,
  member: operation === 'process.program.spawn'
    ? 'spawn'
    : operation === 'process.stdin.end'
    ? 'ChildProcess.stdin.end'
    : 'ChildProcess.stdin.write',
  operation,
  ...(callbackId == null ? {} : { providerData: { callbackId } }),
  resource: {
    ...(inheritedBindingId == null ? {} : { inheritedBindingId }),
    requested
  },
  runtime: { generation: 1 }
})
const authority = () => {
  const completed = []
  return {
    bindings: [{
      capabilityName: 'host.process.execute',
      constraints: {
        executableIds: ['tool'],
        limits: { maxConcurrentProcesses: 1 },
        rootIds: []
      },
      providerModule: 'host.process'
    }],
    complete(result, resources) {
      completed.push({ resources, result })
      return { resources, result }
    },
    completed
  }
}

test('binds stdin callbacks to native write and end terminals', async t => {
  const child = new EventEmitter()
  const stdin = new EventEmitter()
  let destroyed = false
  let endCallback
  let writeCallback
  let writeCalls = 0
  Object.defineProperty(stdin, 'destroyed', { get: () => destroyed })
  stdin.destroy = () => {
    destroyed = true
    stdin.emit('close')
  }
  stdin.end = callback => {
    endCallback = callback
  }
  stdin.write = (_data, callback) => {
    writeCalls += 1
    writeCallback = callback
    return false
  }
  child.stdin = stdin
  child.stdout = null
  child.stderr = null
  const backend = {
    closeGeneration() {},
    descriptor: { features: { shell: false, signals: true, synchronousSpawn: false } },
    prepareLaunch() {
      return { cwd: '/', executablePath: '/virtual/tool' }
    },
    spawn() {
      queueMicrotask(() => child.emit('spawn'))
      return {
        child,
        killTree(signal) {
          stdin.destroy()
          child.emit('exit', null, signal)
          child.emit('close', null, signal)
        }
      }
    }
  }
  const provider = new NodeProcessProviderV1(
    {
      backend: { backendId: 'test-v1', configuration: {} },
      environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
      executables: [{
        executable: { kind: 'guestPath', path: '/virtual/tool' },
        executableId: 'tool',
        fixedArgs: [],
        shell: false
      }]
    },
    {
      access: 'sandboxed',
      environment: { allowedNames: [], maxValueBytes: 1024 },
      executables: [{ argumentBytes: 1024, executableId: 'tool' }],
      limits: {
        maxConcurrentProcesses: 1,
        maxExecutionTimeMs: 1000,
        maxOpenPipes: 1,
        maxStderrBytes: 1024,
        maxStdinBytes: 1024,
        maxStdoutBytes: 1024,
        maxTotalProcesses: 1
      }
    },
    1,
    { get: () => backend }
  )
  t.after(() => provider.close())
  const spawnAuthority = authority()
  provider.invoke(
    context('process.program.spawn', {
      args: [],
      environmentScope: 'processTree',
      options: { stdio: ['pipe', 'ignore', 'ignore'] }
    }, executableResource),
    spawnAuthority
  )
  const terminal = spawnAuthority.completed[0]
  const facade = terminal.result.value
  const resource = terminal.resources[0].resource
  const stdinPublication = terminal.resources.find(item => item.resourceType === 'process.stdin')
  const events = []
  stdinPublication.subscribe(envelope => events.push(JSON.parse(JSON.stringify(envelope.value))))

  const writeAuthority = authority()
  const writeTerminal = provider.invoke(
    context('process.stdin.write', 'data', resource, facade.stdin.binding.bindingId, 1),
    writeAuthority
  )
  assert.equal(writeTerminal.result.value, false)
  assert.deepEqual(events, [])
  writeCallback()
  assert.deepEqual(events, [{ callbackId: 1, error: null, event: 'callback' }])

  provider.invoke(context('process.stdin.write', 'data', resource, facade.stdin.binding.bindingId, 2), authority())
  writeCallback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
  assert.equal(events.at(-1).callbackId, 2)
  assert.equal(events.at(-1).error.code, 'EIO')

  provider.invoke(context('process.stdin.end', {}, resource, facade.stdin.binding.bindingId, 3), authority())
  assert.equal(events.some(event => event.callbackId === 3), false)
  endCallback()
  assert.deepEqual(events.at(-1), { callbackId: 3, error: null, event: 'callback' })

  assert.throws(() =>
    provider.invoke(
      context('process.stdin.write', 'after-end', resource, facade.stdin.binding.bindingId, 4),
      authority()
    ), error => error.code === 'resource.stale')
  assert.equal(writeCalls, 2)

  provider.invoke(context('process.stdin.end', {}, resource, facade.stdin.binding.bindingId, 5), authority())
  await Promise.resolve()
  assert.deepEqual(events.at(-1), { callbackId: 5, error: null, event: 'callback' })
})
