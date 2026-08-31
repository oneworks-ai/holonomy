import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
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
const context = (operation, argumentsValue, requested = executableResource, inheritedBindingId) => ({
  arguments: argumentsValue,
  member: operation === 'process.program.spawn' ? 'spawn' : 'ChildProcess.stdin.write',
  operation,
  resource: {
    ...(inheritedBindingId == null ? {} : { inheritedBindingId }),
    requested
  },
  runtime: { generation: 1 }
})
const authority = (executableIds, signals = ['SIGINT', 'SIGKILL', 'SIGTERM']) => {
  const completed = []
  return {
    bindings: signals.length === 0
      ? [{
        capabilityName: 'host.process.signal',
        constraints: { signals },
        providerModule: 'host.process'
      }]
      : [{
        capabilityName: 'host.process.execute',
        constraints: {
          executableIds,
          limits: { maxConcurrentProcesses: 1 },
          rootIds: []
        },
        providerModule: 'host.process'
      }],
    complete(result, resources) {
      completed.push({ resources, result })
      return { resources, result }
    },
    completed,
    invocationBinding: {
      invocationBindingDigest: '2'.repeat(64)
    }
  }
}

test('rechecks Process authority before every inherited resource side effect', async () => {
  let killCalls = 0
  let writeCalls = 0
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const write = child.stdin.write.bind(child.stdin)
  child.stdin.write = (...args) => {
    writeCalls += 1
    return write(...args)
  }
  const backend = {
    closeGeneration() {},
    descriptor: {
      features: { shell: false, signals: true, synchronousSpawn: false }
    },
    prepareLaunch() {
      return { cwd: '/', executablePath: '/virtual/tool' }
    },
    spawn() {
      queueMicrotask(() => child.emit('spawn'))
      return {
        child,
        killTree(signal) {
          killCalls += 1
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
        maxConcurrentProcesses: 2,
        maxExecutionTimeMs: 1000,
        maxOpenPipes: 3,
        maxProcessTreeDepth: 2,
        maxStderrBytes: 1024,
        maxStdinBytes: 1024,
        maxStdoutBytes: 1024,
        maxTotalProcesses: 2
      }
    },
    1,
    { get: () => backend }
  )
  const spawnAuthority = authority(['tool'])
  const descendantArguments = Object.freeze({
    argv: ['/virtual/tool', 'child'],
    cwd: '/',
    environmentId: '1:processTree:process-1',
    environmentScope: 'processTree',
    executableId: 'tool',
    linuxPid: 902,
    parentLinuxPid: 901,
    path: '/virtual/tool',
    processStartTimeTicks: 10_002
  })
  const descendantContext = Object.freeze({
    ...context('process.program.spawn', descendantArguments),
    member: 'authorizeDescendantProcess',
    source: Object.freeze({
      environmentId: descendantArguments.environmentId,
      environmentScope: 'processTree',
      executableId: 'tool',
      kind: 'linuxProcess',
      linuxPid: 902,
      parentLinuxPid: 901,
      processStartTimeTicks: 10_002,
      processResourceId: 'process-1',
      rootLinuxPid: 901,
      syntheticProcessId: 41
    })
  })
  provider.invoke(
    context('process.program.spawn', {
      args: [],
      environmentScope: 'processTree',
      options: { stdio: ['pipe', 'pipe', 'pipe'] }
    }),
    spawnAuthority
  )
  const terminal = spawnAuthority.completed[0]
  const facade = terminal.result.value
  const resource = terminal.resources[0].resource
  const stdinBinding = facade.stdin.binding.bindingId

  const descendantAuthority = authority(['tool'])
  const descendantReceipt = provider.invoke(descendantContext, descendantAuthority)
  assert.equal(descendantReceipt.result.value.authorized, true)
  assert.throws(() =>
    provider.invoke({
      ...descendantContext,
      source: { ...descendantContext.source, executableId: 'different-tool' }
    }, authority(['tool'])), error => error.code === 'policy.denied')
  assert.throws(() =>
    provider.invoke({
      ...descendantContext,
      arguments: { ...descendantArguments, processStartTimeTicks: 20_002 },
      source: { ...descendantContext.source, processStartTimeTicks: 20_002 }
    }, authority(['tool'])), error => error.code === 'resource.handle_limit')
  assert.throws(() =>
    provider.invoke({
      ...descendantContext,
      arguments: { ...descendantArguments, path: '/virtual/other' }
    }, authority(['tool'])), error => error.code === 'policy.denied')
  assert.throws(() =>
    provider.invoke({
      ...descendantContext,
      arguments: {
        ...descendantArguments,
        linuxPid: 903,
        parentLinuxPid: 902,
        processStartTimeTicks: 10_003
      },
      source: {
        ...descendantContext.source,
        linuxPid: 903,
        parentLinuxPid: 902,
        processStartTimeTicks: 10_003
      }
    }, authority(['tool'])), error => error.code === 'resource.handle_limit')

  assert.throws(() =>
    provider.invoke(
      context('process.program.spawn', {
        args: [],
        environmentScope: 'processTree',
        options: { stdio: ['pipe', 'pipe', 'pipe'] }
      }),
      authority(['tool'])
    ), error => error.code === 'resource.handle_limit')

  assert.throws(() =>
    provider.invoke(
      context('process.stdin.write', 'blocked', resource, stdinBinding),
      authority(['different-tool'])
    ), error => error.code === 'capability.denied')
  assert.equal(writeCalls, 0)

  assert.throws(() =>
    provider.invoke(
      context('process.signal.send', 'SIGTERM', resource, facade.binding.bindingId),
      authority(['tool'], [])
    ), error => error.code === 'capability.denied')
  assert.equal(killCalls, 0)

  provider.invoke(context('process.stdin.write', 'allowed', resource, stdinBinding), authority(['tool']))
  assert.equal(writeCalls, 1)
  await provider.close()
  assert.equal(killCalls, 1)
})
