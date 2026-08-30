import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createNodeModuleLaunchV1 } from '../../adapters/node/src/capability-session.mjs'
import {
  compileRuntimeCreationConfigurationV1,
  compileRuntimeCreationHostBindingsV1
} from '../../dist/capability-runtime/index.js'
import {
  createDefaultHostSystemProjectionV1,
  createDefaultNodeDeviceSnapshotV1
} from './capability-runtime-host-snapshots.mjs'
import { serviceError } from './errors.mjs'

const OWNER_ID = 'holonomy-service'

const deviceDescriptor = target => {
  const all = [
    'device.connectivity.cellular.state.read',
    'device.connectivity.read',
    'device.connectivity.wifi.identity.read',
    'device.connectivity.wifi.state.read',
    'device.display.read',
    'device.events.subscribe',
    'device.form-factor.read',
    'device.input.read',
    'device.lifecycle.read',
    'device.media.capabilities.read',
    'device.power.read',
    'device.security.capabilities.read',
    'device.sensor.capabilities.read',
    'device.summary.read',
    'device.thermal.read'
  ]
  const required = target === 'node'
    ? new Set(['device.form-factor.read', 'device.lifecycle.read', 'device.summary.read'])
    : new Set([
      'device.connectivity.cellular.state.read',
      'device.connectivity.read',
      'device.connectivity.wifi.state.read',
      'device.display.read',
      'device.events.subscribe',
      'device.form-factor.read',
      'device.input.read',
      'device.lifecycle.read',
      'device.power.read',
      'device.summary.read'
    ])
  const eventKinds = target === 'node' ? [] : ['connectivity', 'display', 'lifecycle', 'power']
  return {
    operations: all.map(operation => {
      const supported = required.has(operation)
      const optional = target === 'android' && !supported
      return {
        eventKinds: operation === 'device.events.subscribe' ? eventKinds : [],
        maxPrecision: supported || optional ? 'standard' : 'none',
        operation,
        permissionModel: supported || optional ? 'host' : 'none',
        supportLevel: supported ? 'required' : optional ? 'optional' : 'unsupported'
      }
    }),
    providerVersion: '1.0.0',
    schemaVersion: 1,
    target
  }
}

const binding = (bindingId, generation) => ({
  bindingId: `${bindingId}-g${generation}`,
  ownerId: OWNER_ID,
  version: '1'
})

const providerBindings = (policy, generation) => {
  const modules = []
  if (Object.keys(policy.device.operations).length > 0) modules.push('host.device')
  if (policy.filesystem.access === 'sandboxed') modules.push('host.fs')
  if (policy.network.access !== 'none') {
    modules.push(policy.network.access === 'mockOnly' ? 'host.network.mock' : 'host.network')
  }
  if (policy.process.access === 'sandboxed') modules.push('host.process')
  if (Object.keys(policy.systemInformation.fields).length > 0) modules.push('host.system')
  return modules.map(module => ({
    module,
    ownerId: OWNER_ID,
    providerId: `provider-${module.replaceAll('.', '-')}-g${generation}`,
    providerVersion: '1'
  }))
}

export const prepareCapabilityRuntimeV1 = async (
  process,
  middleware,
  stateDirectory,
  factories = {},
  processProfile,
  processBackendInstallation
) => {
  const request = process.capabilityRuntime
  const launch = createNodeModuleLaunchV1({
    moduleRootUrl: process.launch.moduleRootUrl,
    userEntryUrl: process.entryUrl,
    userModules: process.launch.modules
  })
  const target = process.target === 'android' ? 'android' : 'node'
  const policy = request.sandboxPolicy
  const systemProjection = await (factories.systemProjection?.({ policy, process, target }) ??
    createDefaultHostSystemProjectionV1(policy))
  const configuration = compileRuntimeCreationConfigurationV1({
    context: request.context,
    deviceProviderDescriptor: deviceDescriptor(target),
    inspector: { enabled: false },
    launch,
    sandboxPolicy: policy,
    schemaVersion: 1,
    systemProjection
  })
  const hostBindings = compileRuntimeCreationHostBindingsV1({
    engineGate: binding('engine-gate', process.generation),
    initialMiddlewareSet: binding('middleware', process.generation),
    initialObservers: [],
    moduleResolver: binding('module-resolver', process.generation),
    providerBindings: providerBindings(policy, process.generation)
  })
  const deviceSnapshot = await (factories.deviceSnapshot?.({ policy, process, target }) ??
    (target === 'node' ? createDefaultNodeDeviceSnapshotV1() : { deviceReadings: {} }))
  const providerConfiguration = {
    ...deviceSnapshot,
    filesystemRoots: [],
    networkProvider: policy.network.access === 'mockOnly' ? 'host.network.mock' : 'host.network',
    ...(processBackendInstallation == null ? {} : { processBackendInstallation }),
    ...(processProfile == null ? {} : { processProfile })
  }
  if (target === 'node' && policy.filesystem.access === 'sandboxed') {
    if (typeof stateDirectory !== 'string') {
      throw serviceError('service.unavailable', 'Capability Runtime workspace is unavailable')
    }
    const hostPath = join(stateDirectory, 'capability-workspaces', process.id)
    await mkdir(hostPath, { recursive: true })
    providerConfiguration.filesystemRoots = [{ hostPath, rootId: 'workspace' }]
  }
  return Object.freeze({
    initialMiddleware: middleware,
    ownerId: OWNER_ID,
    processId: process.id,
    providerConfiguration,
    runtimeCreation: Object.freeze({ configuration, hostBindings })
  })
}
