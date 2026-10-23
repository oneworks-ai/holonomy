import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it } from 'vitest'

import { HolonomyControlRunner } from '../control-runner.mjs'
import { serviceError } from '../errors.mjs'
import { ControlRegistry } from '../registry.mjs'
import { AtomicServiceStateStore } from '../state-store.mjs'

const harnesses = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close()))
})

const createHarness = async (options = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'holonomy-stop-terminal-'))
  const store = new AtomicServiceStateStore({ directory })
  await store.open()
  const baseRegistry = new ControlRegistry(store)
  await baseRegistry.refreshDevices([{
    id: 'android:emulator-5554',
    kind: 'emulator',
    platform: 'android',
    serial: 'emulator-5554',
    state: 'online'
  }])
  const start = await baseRegistry.admitProcessStart({
    deviceId: 'android:emulator-5554',
    entryUrl: 'app+local://workspace/entry.mjs',
    inspectorMode: 'off',
    isolation: 'runtime',
    launch: { modules: [] },
    target: 'android'
  }, 'start')
  const started = start.value.process
  await baseRegistry.updateOperation(start.value.operation.id, 'running')
  for (const state of ['staging', 'starting', 'running']) {
    await baseRegistry.updateProcess(started.id, started.generation, { state })
  }
  await baseRegistry.updateOperation(start.value.operation.id, 'succeeded', {
    result: { process: baseRegistry.get('processes', started.id, 'Runtime process') }
  })
  if (options.initialTerminal) {
    await baseRegistry.updateProcess(started.id, started.generation, {
      exit: { code: 0, reason: 'completed' },
      state: 'exited'
    })
  }
  const stop = await baseRegistry.admitProcessAction('stop', started.id, started.generation, 'stop')
  const supersedingStop = options.supersedeStop
    ? await baseRegistry.admitProcessAction('stop', started.id, started.generation, 'next-stop')
    : undefined
  const registry = options.registryProxy?.(baseRegistry, stop.value) ?? baseRegistry
  const adapter = {
    stopProcess: async input => options.stopProcess?.(input, baseRegistry, stop.value)
  }
  const runner = new HolonomyControlRunner({
    adapterDispatcher: { close: async () => {}, target: () => adapter },
    fixtureManager: { close: async () => {} },
    inspectorProxy: {
      close: async () => {},
      closeProcess: () => options.closeProcess?.()
    },
    outputPump: {
      captureStartupFailure: async () => {},
      close: async () => {},
      stop: async () => {}
    },
    registry
  })
  const harness = {
    close: async () => {
      await runner.close()
      await rm(directory, { force: true, recursive: true })
    },
    process: () => baseRegistry.get('processes', started.id, 'Runtime process'),
    run: async () => {
      runner.scheduleStop(stop.value)
      await runner.close()
    },
    supersedingStop: supersedingStop?.value,
    stop: stop.value,
    operation: () => baseRegistry.get('operations', stop.value.operation.id, 'Operation')
  }
  harnesses.push(harness)
  return harness
}

it('retains a same-generation natural terminal when it wins the stop publication race', async () => {
  const test = await createHarness({
    stopProcess: async (_input, registry, stop) => {
      await registry.updateProcess(stop.process.id, stop.process.generation, {
        activeOperationId: null,
        exit: { code: 0, reason: 'completed' },
        state: 'exited'
      })
    }
  })
  await test.run()
  assert.equal(test.operation().state, 'succeeded')
  assert.equal(test.process().state, 'exited')
  assert.deepEqual(test.process().exit, { code: 0, reason: 'completed' })
  assert.deepEqual(test.operation().result.process.exit, { code: 0, reason: 'completed' })
})

it('retains a same-state natural terminal that commits after the stop pre-read', async () => {
  let injected = false
  const test = await createHarness({
    registryProxy: base =>
      new Proxy(base, {
        get(target, key) {
          if (key === 'completeProcessStop') {
            return async (process, operationId) => {
              if (!injected) {
                injected = true
                await target.updateProcess(process.id, process.generation, {
                  activeOperationId: null,
                  exit: { code: 1, reason: 'natural_cancel' },
                  state: 'cancelled'
                })
              }
              return await target.completeProcessStop(process, operationId)
            }
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
  })
  await test.run()
  assert.equal(injected, true)
  assert.equal(test.operation().state, 'succeeded')
  assert.deepEqual(test.process().exit, { code: 1, reason: 'natural_cancel' })
  assert.deepEqual(test.operation().result.process.exit, { code: 1, reason: 'natural_cancel' })
})

it('clears only the admitted stop ownership on an already terminal process', async () => {
  let attempted = false
  const test = await createHarness({
    initialTerminal: true,
    stopProcess: async () => {
      attempted = true
    }
  })
  assert.equal(test.process().activeOperationId, test.stop.operation.id)
  await test.run()
  assert.equal(attempted, false)
  assert.equal(test.operation().state, 'succeeded')
  assert.equal(test.process().activeOperationId, undefined)
  assert.deepEqual(test.process().exit, { code: 0, reason: 'completed' })
})

it('does not clear another stop operation ownership on a terminal process', async () => {
  const test = await createHarness({ initialTerminal: true, supersedeStop: true })
  await test.run()
  assert.equal(test.operation().state, 'failed')
  assert.equal(test.process().activeOperationId, test.supersedingStop.operation.id)
  assert.deepEqual(test.process().exit, { code: 0, reason: 'completed' })
})

it('fails the operation after a lease finalizer throws', async () => {
  const test = await createHarness({
    closeProcess: () => {
      throw new Error('private lease detail')
    }
  })
  await test.run()
  assert.equal(test.operation().state, 'failed')
  assert.deepEqual(test.operation().error, { code: 'service.unavailable', retryable: true })
  assert.equal(test.process().state, 'failed')
})

it('retains a natural failed terminal that wins the stop failure publication race', async () => {
  let injected = false
  const test = await createHarness({
    closeProcess: () => {
      throw new Error('private lease detail')
    },
    registryProxy: base =>
      new Proxy(base, {
        get(target, key) {
          if (key === 'completeProcessStop') {
            return async (process, operationId, outcome) => {
              if (outcome === 'failed' && !injected) {
                injected = true
                await target.updateProcess(process.id, process.generation, {
                  activeOperationId: null,
                  exit: { code: 9, reason: 'natural_failure' },
                  state: 'failed'
                })
              }
              return await target.completeProcessStop(process, operationId, outcome)
            }
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
  })
  await test.run()
  assert.equal(injected, true)
  assert.equal(test.operation().state, 'failed')
  assert.deepEqual(test.process().exit, { code: 9, reason: 'natural_failure' })
})

it('attempts the owned OS stop if recording running fails', async () => {
  let attempted = false
  const test = await createHarness({
    registryProxy: (base, stop) =>
      new Proxy(base, {
        get(target, key) {
          if (key === 'updateOperation') {
            return async (id, state, patch) => {
              if (id === stop.operation.id && state === 'running') throw new Error('running write failed')
              return await target.updateOperation(id, state, patch)
            }
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }),
    stopProcess: async () => {
      attempted = true
    }
  })
  await test.run()
  assert.equal(attempted, true)
  assert.equal(test.process().cleanupPending, undefined)
  assert.equal(test.process().state, 'failed')
  assert.equal(test.operation().state, 'failed')
})

it('retains cleanup ownership if the fallback OS stop fails', async () => {
  let attempted = false
  const test = await createHarness({
    registryProxy: (base, stop) =>
      new Proxy(base, {
        get(target, key) {
          if (key === 'updateOperation') {
            return async (id, state, patch) => {
              if (id === stop.operation.id && state === 'running') throw new Error('running write failed')
              return await target.updateOperation(id, state, patch)
            }
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }),
    stopProcess: async () => {
      attempted = true
      throw new Error('private OS failure')
    }
  })
  await test.run()
  assert.equal(attempted, true)
  assert.equal(test.process().cleanupPending, true)
  assert.equal(test.operation().state, 'failed')
})

it('fails the operation after a one-shot process registry rejection', async () => {
  let rejected = false
  const test = await createHarness({
    registryProxy: base =>
      new Proxy(base, {
        get(target, key) {
          if (key === 'completeProcessStop') {
            return async (...args) => {
              if (!rejected) {
                rejected = true
                throw new Error('transient process write')
              }
              return await target.completeProcessStop(...args)
            }
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
  })
  await test.run()
  assert.equal(rejected, true)
  assert.equal(test.operation().state, 'failed')
  assert.equal(test.process().state, 'failed')
})

it('retries a one-shot failure while recording the failed process', async () => {
  let rejected = false
  const test = await createHarness({
    closeProcess: () => {
      throw new Error('private lease detail')
    },
    registryProxy: base =>
      new Proxy(base, {
        get(target, key) {
          if (key === 'completeProcessStop') {
            return async (process, operationId, outcome) => {
              if (outcome === 'failed' && !rejected) {
                rejected = true
                throw new Error('transient process failure write')
              }
              return await target.completeProcessStop(process, operationId, outcome)
            }
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
  })
  await test.run()
  assert.equal(rejected, true)
  assert.equal(test.process().state, 'failed')
  assert.equal(test.operation().state, 'failed')
})

it('fails the operation after a one-shot success registry rejection without rewriting a terminal process', async () => {
  let rejected = false
  const test = await createHarness({
    registryProxy: (base, stop) =>
      new Proxy(base, {
        get(target, key) {
          if (key === 'updateOperation') {
            return async (id, state, patch) => {
              if (id === stop.operation.id && state === 'succeeded' && !rejected) {
                rejected = true
                throw new Error('transient operation write')
              }
              return await target.updateOperation(id, state, patch)
            }
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
  })
  await test.run()
  assert.equal(rejected, true)
  assert.equal(test.operation().state, 'failed')
  assert.equal(test.process().state, 'cancelled')
  assert.deepEqual(test.process().exit, { reason: 'stopped' })
})

it('retries a one-shot failure while recording the failed operation', async () => {
  let rejected = false
  const test = await createHarness({
    closeProcess: () => {
      throw new Error('private lease detail')
    },
    registryProxy: (base, stop) =>
      new Proxy(base, {
        get(target, key) {
          if (key === 'updateOperation') {
            return async (id, state, patch) => {
              if (id === stop.operation.id && state === 'failed' && !rejected) {
                rejected = true
                throw new Error('transient operation failure write')
              }
              return await target.updateOperation(id, state, patch)
            }
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
  })
  await test.run()
  assert.equal(rejected, true)
  assert.equal(test.operation().state, 'failed')
  assert.deepEqual(test.operation().error, { code: 'service.unavailable', retryable: true })
})

it('preserves an already selected operation terminal', async () => {
  let selected
  const test = await createHarness({
    stopProcess: async (_input, registry, stop) => {
      selected = await registry.updateOperation(stop.operation.id, 'cancelled')
    }
  })
  await test.run()
  assert.deepEqual(test.operation(), selected)
})

it('does not let an old stop operation change a new generation', async () => {
  const test = await createHarness({
    stopProcess: async (_input, registry, stop) => {
      await registry.beginRestart(stop.process.id, stop.process.generation, stop.operation.id)
    }
  })
  await test.run()
  assert.equal(test.process().generation, 2)
  assert.equal(test.process().state, 'queued')
  assert.equal(test.operation().state, 'failed')
})

it('retains cleanupPending evidence when the OS stop fails', async () => {
  const test = await createHarness({
    stopProcess: async () => {
      throw serviceError('service.unavailable', 'private OS failure', { details: { cleanupPending: true } })
    }
  })
  await test.run()
  assert.equal(test.operation().state, 'failed')
  assert.deepEqual(test.operation().error, { code: 'service.unavailable', retryable: true })
  assert.equal(test.process().state, 'failed')
  assert.equal(test.process().cleanupPending, true)
})

it('retries a one-shot cleanupPending registry rejection after OS stop failure', async () => {
  let rejected = false
  const test = await createHarness({
    registryProxy: base =>
      new Proxy(base, {
        get(target, key) {
          if (key === 'updateProcessCleanupPending') {
            return async (...args) => {
              if (!rejected) {
                rejected = true
                throw new Error('transient pending write')
              }
              return await target.updateProcessCleanupPending(...args)
            }
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }),
    stopProcess: async () => {
      throw new Error('private OS failure')
    }
  })
  await test.run()
  assert.equal(rejected, true)
  assert.equal(test.process().cleanupPending, true)
  assert.equal(test.operation().state, 'failed')
})
