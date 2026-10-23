import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { DEVICE_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-device'
import { SYSTEM_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-system'
import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel'
import ts from 'typescript'
import { describe, it } from 'vitest'

const source = readFileSync(
  new URL('../../../runtime-host/src/runtimeBootstrap/capability-host-runtime.mjs', import.meta.url),
  'utf8'
)

// Test the actual Android Host glue with a controlled Kernel boundary. The
// Kernel's Policy/authority matrix and real Javet delivery have separate owners.
const harness = failure => {
  const invocations = []
  const result = Object.freeze({ reading: 'host-value' })
  class Kernel {
    invokeFromSourceImmediate(input) {
      invocations.push(JSON.parse(JSON.stringify(input)))
      if (failure) throw failure
      return result
    }

    invokeFromSource() {
      throw new Error('Async dispatch needs a Host task and cannot settle inside the synchronous JNI callback')
    }
  }
  class Bridge {
    bind() {
      return this
    }
  }
  const dependencies = {
    '@holonomyjs/capability-device': { DEVICE_OPERATION_REGISTRY_V1 },
    '@holonomyjs/capability-system': { SYSTEM_OPERATION_REGISTRY_V1 },
    '@holonomyjs/capability-fs': { LinuxFilesystemCapabilityBridgeV1: Bridge },
    '@holonomyjs/capability-network': { LinuxProcessNetworkCapabilityBridgeV1: Bridge },
    '@holonomyjs/capability-process': { LinuxProcessExecutionCapabilityBridgeV1: Bridge },
    '@holonomyjs/runtime/kernel': {
      CapabilityInvocationError,
      CapabilityRuntimeInvocationKernelV1: Kernel,
      admitRuntimeCreationV1: () => ({})
    },
    './android-capability-provider.mjs': {
      createAndroidHostProviderV1: (_host, module) => ({ execution: 'sync', module })
    },
    './android-storage-provider.mjs': {
      createAndroidStorageProvider: () => null
    }
  }
  const exports = {}
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  vm.runInNewContext(compiled, {
    exports,
    require: name => {
      assert.ok(Object.hasOwn(dependencies, name), `Uncontrolled dependency: ${name}`)
      return dependencies[name]
    }
  })
  const runtime = exports.createAndroidCapabilityHostRuntime({
    capabilityConfiguration: () =>
      JSON.stringify({
        generation: 1,
        session: {
          ownerId: 'host',
          processId: 'runtime',
          runtimeCreation: {
            configuration: { sandboxPolicy: { storage: { access: 'none' } } },
            hostBindings: {
              engineGate: { bindingId: 'engine' },
              initialMiddlewareSet: { bindingId: 'middleware' },
              moduleResolver: { bindingId: 'resolver' },
              providerBindings: []
            }
          }
        }
      })
  })
  const input = command => ({
    command,
    environmentId: 'environment',
    executableId: 'hoholo',
    linuxPid: 7,
    parentLinuxPid: 1,
    processId: 11,
    processResourceId: 'process-resource',
    processStartTimeTicks: 123,
    rootLinuxPid: 7,
    scope: 'runtime'
  })
  return { input, invocations, result, runtime }
}

describe('android trusted Backend capability dispatch', () => {
  for (const command of [['device', 'summary'], ['system', 'read', 'os.arch']]) {
    it(`settles ${command.join(' ')} immediately without losing mode or source identity`, () => {
      const h = harness()
      assert.equal(h.runtime.invokeFromSource('linuxCapability', h.input(command)), h.result)
      assert.equal(h.invocations.length, 1)
      const actual = h.invocations[0]
      const descriptor = command[0] === 'device'
        ? DEVICE_OPERATION_REGISTRY_V1.find(row =>
          row.operation === 'device.summary.read' && row.module === 'holo:device/promises'
        )
        : SYSTEM_OPERATION_REGISTRY_V1.find(row => row.limitsOwner.startsWith('SystemFieldValueMapV1.os.arch:'))
      assert.equal(actual.module, descriptor.module)
      assert.equal(actual.member, descriptor.member)
      assert.equal(actual.mode, descriptor.modes[0])
      assert.deepEqual(actual.source, {
        environmentId: 'environment',
        environmentScope: 'runtime',
        executableId: 'hoholo',
        kind: 'linuxProcess',
        linuxPid: 7,
        parentLinuxPid: 1,
        processResourceId: 'process-resource',
        processStartTimeTicks: 123,
        rootLinuxPid: 7,
        syntheticProcessId: 11
      })
    })
  }

  for (const code of ['policy.denied', 'runtime.async_required']) {
    it(`propagates ${code} without retrying through async dispatch`, () => {
      const error = new CapabilityInvocationError(code, 'device.summary.read')
      const h = harness(error)
      assert.throws(
        () => h.runtime.invokeFromSource('linuxCapability', h.input(['device', 'summary'])),
        value => value === error
      )
      assert.equal(h.invocations.length, 1)
    })
  }
})
