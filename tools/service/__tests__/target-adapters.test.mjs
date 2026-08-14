import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import process from 'node:process'
import { describe, it } from 'vitest'

import { AndroidSessionCommandPort, executeAndroidCommand } from '../android-command-port.mjs'
import { ANDROID_CONTROL_ENDPOINT, AndroidControlChannel } from '../android-control-channel.mjs'
import { createAndroidRuntimeAdapter } from '../android-target-adapter.mjs'
import { ConformanceFixtureManager, withFixtureUrl } from '../fixture-manager.mjs'
import { createNodeRuntimeAdapter } from '../node-target-adapter.mjs'
import { createOptionalAndroidRuntimeAdapter } from '../optional-android-target-adapter.mjs'
import { compileEffectiveSandboxPolicy, compileSandboxPlan } from '../sandbox-policy.mjs'
import { createTargetAdapterDispatcher } from '../target-adapters.mjs'
import { restrictedSandboxPolicy } from './sandbox-fixture.mjs'

const processRecord = (target = 'node') => ({
  deviceId: target === 'node' ? 'node:local' : 'android:emulator-5554',
  entryUrl: 'app+local://workspace/main.mjs',
  generation: 1,
  id: 'process_test',
  inspectorMode: 'off',
  isolation: 'runtime',
  launch: {
    argv: ['--fixture'],
    env: { HOLONOMY_FIXTURE_URL: 'http://127.0.0.1:43210' },
    modules: [{ source: 'export {}', url: 'app+local://workspace/main.mjs' }]
  },
  sandboxPolicy: restrictedSandboxPolicy(['http://127.0.0.1:43210'], {
    allowedSchemes: ['http'],
    allowPrivateNetwork: true
  }),
  target
})

class FakeSupervisor extends EventEmitter {
  ruleCalls = []
  stopCalls = 0

  async start(input) {
    this.input = input
    return { inspectorUrl: undefined }
  }

  async stop() {
    this.stopCalls += 1
  }

  async setRules(rules, revision) {
    this.ruleCalls.push({ revision, rules })
  }
}

describe('target adapter contracts', () => {
  it('keeps node:local available when Android SDK discovery is unavailable', async () => {
    const android = createOptionalAndroidRuntimeAdapter({
      createAdapter: () => {
        throw new Error('adb missing')
      }
    })
    const dispatcher = createTargetAdapterDispatcher({
      android,
      node: createNodeRuntimeAdapter({
        createSupervisor: () => new FakeSupervisor()
      })
    })
    assert.deepEqual(await dispatcher.listDevices({}), [{
      id: 'node:local',
      kind: 'local',
      platform: 'node',
      serial: 'local',
      state: 'online'
    }])
    const process = processRecord()
    await dispatcher.target('node').startProcess({ process })
    await dispatcher.target('node').stopProcess({ process })
    await assert.rejects(
      dispatcher.target('android').startProcess({ process: processRecord('android') }),
      error => error.code === 'service.unsupported'
    )
    await dispatcher.close()
  })

  it('verifies Android installation per serial and cancels spawned commands', async () => {
    const executions = []
    const commandSignals = []
    const port = new AndroidSessionCommandPort({
      adb: 'adb',
      build: false,
      channel: {
        close: async () => undefined,
        send: async (_serial, _command, options) => {
          commandSignals.push(options.signal)
          return { ack: { accepted: true } }
        }
      },
      execute: async (file, args) => {
        executions.push({ args, file })
        return 'package:ai.oneworks.holonomy.e2e'
      }
    })
    const commandController = new AbortController()
    await port.command('emulator-5554', { command: 'status' }, { signal: commandController.signal })
    await port.command('emulator-5554', { command: 'status' })
    await port.command('emulator-5556', { command: 'status' })
    assert.deepEqual(
      executions.filter(call => call.args.includes('pm')).map(call => call.args[1]),
      ['emulator-5554', 'emulator-5556']
    )
    assert.equal(commandSignals[0], commandController.signal)

    const controller = new AbortController()
    const pending = executeAndroidCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
      signal: controller.signal
    })
    controller.abort()
    await assert.rejects(pending, error => error.message === 'Android command was cancelled')

    const unsupported = new AndroidSessionCommandPort({
      adb: 'adb',
      build: false,
      channel: {
        close: async () => undefined,
        send: async () => ({ ack: { accepted: false, errorCode: 'session.isolation_unsupported' } })
      },
      execute: async () => 'package:ai.oneworks.holonomy.e2e'
    })
    await assert.rejects(
      unsupported.command('emulator-5554', { command: 'create' }),
      error => error.code === 'process.isolation_unsupported' && error.status === 501
    )
  })

  it('discovers and reuses only its owner-private Android session-v2 forward', async () => {
    let descriptor = '2\n123\nholonomy.session.first\n'
    let nextPort = 41000
    const calls = []
    const exchanges = []
    const channel = new AndroidControlChannel({
      exchange: async (port, command) => {
        exchanges.push({ command, port })
        return { ack: { accepted: true } }
      },
      runAdb: async args => {
        calls.push(args)
        if (args.includes(ANDROID_CONTROL_ENDPOINT)) return descriptor
        if (args.includes('pidof')) return `${descriptor.split('\n')[1]}\n`
        if (args.includes('--remove')) return ''
        return String(nextPort++)
      }
    })
    await channel.send('emulator-5554', { command: 'status' })
    await channel.send('emulator-5554', { command: 'status' })
    assert.deepEqual(exchanges.map(value => value.port), [41000, 41000])
    assert.equal(calls.filter(args => args.includes('localabstract:holonomy.session.first')).length, 1)
    descriptor = '2\n456\nholonomy.session.second\n'
    await channel.send('emulator-5554', { command: 'status' })
    assert.equal(exchanges.at(-1).port, 41001)
    assert.ok(calls.some(args => args.includes('tcp:41000') && args.includes('--remove')))
    await channel.close()
    assert.ok(calls.some(args => args.includes('tcp:41001') && args.includes('--remove')))
  })

  it('maps Node process termination to one generation-fenced terminal event', async () => {
    const supervisor = new FakeSupervisor()
    const adapter = createNodeRuntimeAdapter({ createSupervisor: () => supervisor })
    const process = processRecord()
    await adapter.startProcess({ process })
    assert.deepEqual(supervisor.input.argv, ['--fixture'])
    assert.equal(supervisor.input.env.HOLONOMY_FIXTURE_URL, 'http://127.0.0.1:43210')
    const terminals = []
    const unsubscribe = await adapter.subscribeProcess({ onTerminal: event => terminals.push(event), process })
    supervisor.emit('log', { level: 'error', text: 'Runtime terminated: process.exit(0)' })
    supervisor.emit('state', { state: 'failed' })
    await Promise.resolve()
    assert.deepEqual(terminals, [{
      exit: { code: 0, reason: 'completed' },
      generation: 1,
      state: 'exited'
    }])
    assert.equal(supervisor.stopCalls, 1)
    unsubscribe()
    await adapter.removeProcess({ process })
  })

  it('forwards one frozen capability Runtime launch through both target adapters', async () => {
    const capabilityRuntime = {
      initialMiddleware: { behavior: 'allow' },
      ownerId: 'service-owner',
      processId: 'process_test',
      providerConfiguration: { deviceReadings: {}, filesystemRoots: [], networkProvider: 'host.network' },
      runtimeCreation: { configuration: {}, hostBindings: {} }
    }
    const supervisor = new FakeSupervisor()
    const nodeProcess = processRecord()
    const node = createNodeRuntimeAdapter({ createSupervisor: () => supervisor })
    await node.startProcess({ capabilityRuntime, process: nodeProcess })
    assert.equal(supervisor.input.capabilityRuntime, capabilityRuntime)
    await node.removeProcess({ process: nodeProcess })

    const commands = []
    const androidProcess = processRecord('android')
    const android = createAndroidRuntimeAdapter({
      commandPort: {
        close: async () => undefined,
        command: async (_serial, command) => {
          commands.push(command)
          return { ack: { accepted: true, generation: command.command === 'create' ? 0 : 1 } }
        },
        listDevices: async () => [],
        removeForward: async () => undefined,
        removeReverse: async () => undefined
      },
      emulatorManager: { close: async () => undefined, listEmulators: async () => [] }
    })
    await android.startProcess({ capabilityRuntime, process: androidProcess })
    assert.equal(commands.find(command => command.command === 'create').spec.capabilityRuntime, capabilityRuntime)
    await android.removeProcess({ process: androidProcess })
  })

  it('recreates the Android Session so restart adopts the new generation snapshot', async () => {
    const commands = []
    const commandPort = {
      close: async () => undefined,
      command: async (_serial, command) => {
        commands.push(command)
        if (command.command === 'create') return { ack: { accepted: true, generation: 0 } }
        return { ack: { accepted: true, generation: command.command === 'start' ? 1 : command.expectedGeneration } }
      },
      listDevices: async () => [],
      removeForward: async () => undefined,
      removeReverse: async () => undefined
    }
    const android = createAndroidRuntimeAdapter({
      commandPort,
      emulatorManager: { close: async () => undefined, listEmulators: async () => [] }
    })
    const first = processRecord('android')
    await android.startProcess({ capabilityRuntime: { generation: 1 }, process: first })
    const second = { ...first, generation: 2 }
    await android.startProcess({ capabilityRuntime: { generation: 2 }, process: second })
    assert.deepEqual(commands.map(command => command.command), ['create', 'start', 'dispose', 'create', 'start'])
    assert.deepEqual(
      commands.filter(command => command.command === 'create').map(command => command.spec.capabilityRuntime),
      [{ generation: 1 }, { generation: 2 }]
    )
    await android.close()
  })

  it('passes monotonic PUT, DELETE, PUT revisions to Node and Android providers', async () => {
    const process = processRecord()
    const supervisor = new FakeSupervisor()
    const node = createNodeRuntimeAdapter({ createSupervisor: () => supervisor })
    await node.startProcess({ process })
    await node.applyNetworkRules({
      networkRules: { mode: 'failClosed', ruleRevision: '1', rules: [] },
      process
    })
    await node.removeNetworkRules({ networkRules: { mode: 'passthrough', ruleRevision: '2' }, process })
    await node.applyNetworkRules({
      networkRules: { mode: 'passthrough', ruleRevision: '3', rules: [] },
      process
    })
    assert.deepEqual(supervisor.ruleCalls.map(value => value.revision), [1, 2, 3])
    await node.removeProcess({ process })

    const commands = []
    const androidProcess = processRecord('android')
    const android = createAndroidRuntimeAdapter({
      commandPort: {
        close: async () => undefined,
        command: async (_serial, command) => {
          commands.push(command)
          return { ack: { accepted: true, generation: 1 }, state: { phase: 'running' } }
        },
        listDevices: async () => [],
        removeForward: async () => undefined,
        removeReverse: async () => undefined
      },
      emulatorManager: { close: async () => undefined, listEmulators: async () => [] }
    })
    await android.startProcess({ process: androidProcess })
    await android.applyNetworkRules({
      networkRules: { mode: 'failClosed', ruleRevision: '1', rules: [] },
      process: androidProcess
    })
    await android.removeNetworkRules({
      networkRules: { mode: 'passthrough', ruleRevision: '2' },
      process: androidProcess
    })
    await android.applyNetworkRules({
      networkRules: { mode: 'passthrough', ruleRevision: '3', rules: [] },
      process: androidProcess
    })
    assert.deepEqual(
      commands.filter(command => command.command === 'control').map(command => [
        command.value.expectedRevision,
        command.value.rules.mode
      ]),
      [['0', 'failClosed'], ['1', 'passthrough'], ['2', 'passthrough']]
    )
    await android.removeProcess({ process: androidProcess })
  })

  it('uses Android session-v2 runtime isolation and observes terminal status without stdout polling', async () => {
    const commands = []
    const timers = []
    const commandPort = {
      close: async () => undefined,
      command: async (_serial, command) => {
        commands.push(command)
        if (command.command === 'create') {
          return { ack: { accepted: true, generation: 0 }, state: { phase: 'created' } }
        }
        if (command.command === 'status') {
          return {
            ack: { accepted: true, generation: 1 },
            result: { exitCode: 0, generation: 1 },
            state: { phase: 'completed' }
          }
        }
        return { ack: { accepted: true, generation: 1 }, state: { phase: 'running' } }
      },
      listDevices: async () => [],
      removeForward: async () => undefined,
      removeReverse: async () => undefined
    }
    const adapter = createAndroidRuntimeAdapter({
      commandPort,
      pollIntervalMs: 1,
      setTimer: callback => {
        timers.push(callback)
        return { unref() {} }
      }
    })
    const process = processRecord('android')
    const initialNetworkRuleSet = { mode: 'passthrough', rules: [] }
    await adapter.startProcess({ initialNetworkRuleSet, process })
    const create = commands.find(command => command.command === 'create')
    assert.equal(create.spec.isolation, 'runtime')
    assert.deepEqual(create.spec.sandboxPolicy, process.sandboxPolicy)
    assert.equal(create.spec.sandboxPlan, undefined)
    assert.deepEqual(create.spec.initialControls, [{
      operation: 'network.rules.replace',
      value: initialNetworkRuleSet
    }])
    const terminals = []
    await adapter.subscribeProcess({ onTerminal: event => terminals.push(event), process })
    timers.shift()()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(terminals, [{
      exit: { code: 0, reason: 'completed' },
      generation: 1,
      state: 'exited'
    }])
    await adapter.removeProcess({ process })
    assert.ok(commands.some(command => command.command === 'dispose'))
  })

  it('runs the service-owned fixture through the real Node Runtime Fetch path', async () => {
    const fixtures = new ConformanceFixtureManager()
    const adapter = createNodeRuntimeAdapter()
    const process = {
      ...processRecord(),
      fixture: { kind: 'conformance-network-v1' },
      launch: {
        modules: [{
          source: `
            import process from 'node:process'
            const response = await fetch(process.env.HOLONOMY_FIXTURE_URL + '/profile')
            console.log('SERVICE_FIXTURE:' + await response.text())
            setTimeout(() => process.exit(0), 10)
          `,
          url: 'app+local://workspace/main.mjs'
        }]
      },
      sandboxPolicy: restrictedSandboxPolicy(['http://conformance.invalid'], {
        allowedSchemes: ['http'],
        allowPrivateNetwork: true
      })
    }
    try {
      const fixture = await fixtures.start(process)
      const fixtureRuntimeUrl = await adapter.exposeFixture({
        baseUrl: fixture.baseUrl,
        process
      })
      const effective = compileEffectiveSandboxPolicy(process.sandboxPolicy, fixtureRuntimeUrl)
      const launch = withFixtureUrl({ ...process, sandboxPolicy: effective.policy }, fixtureRuntimeUrl)
      const sandboxPlan = compileSandboxPlan({
        generation: launch.generation,
        policy: launch.sandboxPolicy,
        processId: launch.id,
        target: launch.target
      })
      await adapter.startProcess({
        initialNetworkRuleSet: { mode: 'passthrough', rules: [] },
        process: launch,
        sandboxPlan
      })
      const terminal = new Promise(resolve => {
        void adapter.subscribeProcess({ onTerminal: resolve, process: launch })
      })
      let output
      for (let turn = 0; turn < 500; turn += 1) {
        const logs = await adapter.readLogs({ after: 0, limit: 100, process: launch })
        output = logs.events.find(event => event.chunk.startsWith('SERVICE_FIXTURE:'))
        if (output != null) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(output?.chunk, 'SERVICE_FIXTURE:{"runtime":"holonomy"}')
      assert.deepEqual(await terminal, {
        exit: { code: 0, reason: 'completed' },
        generation: 1,
        state: 'exited'
      })
      await adapter.removeProcess({ process: launch })
    } finally {
      await adapter.close({})
      await fixtures.close()
    }
  }, 30_000)
})
