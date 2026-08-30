import { DEVICE_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-device'
import { LinuxFilesystemCapabilityBridgeV1 } from '@holonomyjs/capability-fs'
import { LinuxProcessNetworkCapabilityBridgeV1 } from '@holonomyjs/capability-network'
import { LinuxProcessExecutionCapabilityBridgeV1 } from '@holonomyjs/capability-process'
import { SYSTEM_OPERATION_REGISTRY_V1 } from '@holonomyjs/capability-system'
import {
  CapabilityInvocationError,
  CapabilityRuntimeInvocationKernelV1,
  admitRuntimeCreationV1
} from '@holonomyjs/runtime/kernel'

import { createAndroidHostProviderV1 } from './android-capability-provider.mjs'

const PROVIDERS = new Set([
  'host.device',
  'host.fs',
  'host.network',
  'host.network.mock',
  'host.process',
  'host.system'
])

const initialMiddleware = configuration => {
  const behavior = configuration?.behavior ?? 'allow'
  const middleware = behavior === 'allow'
    ? (_context, next) => next()
    : behavior === 'deny'
    ? context => {
      throw new CapabilityInvocationError(
        'middleware.permission_denied',
        context.operation,
        context.resource.requested.semanticResourceDigest
      )
    }
    : behavior === 'throw'
    ? () => {
      throw new Error('Host middleware failure')
    }
    : () => new Promise(() => undefined)
  return Object.freeze({
    registrations: Object.freeze([Object.freeze({
      execution: behavior === 'timeout' ? 'async' : 'sync',
      layer: 'application',
      matcher: configuration?.matcher ?? Object.freeze({}),
      middleware,
      registrationId: 'android.initial',
      ...(configuration?.timeoutMs == null ? {} : { timeoutMs: configuration.timeoutMs })
    })]),
    schemaVersion: 1
  })
}

const linuxCapabilityOperation = command => {
  if (command[0] === 'device') {
    const operation = command.length === 2 && command[1] === 'summary'
      ? 'device.summary.read'
      : command.length === 3 && command[1] === 'read'
      ? command[2]
      : undefined
    return DEVICE_OPERATION_REGISTRY_V1.find(item =>
      item.operation === operation && item.module === 'holo:device/promises' && item.modes.includes('promise')
    )
  }
  if (command[0] === 'system' && command.length === 3 && command[1] === 'read') {
    return SYSTEM_OPERATION_REGISTRY_V1.find(item =>
      item.limitsOwner.startsWith(`SystemFieldValueMapV1.${command[2]}:`)
    )
  }
  return undefined
}

const linuxCapabilitySource = input =>
  Object.freeze({
    environmentId: input.environmentId,
    environmentScope: input.scope,
    executableId: input.executableId,
    kind: 'linuxProcess',
    linuxPid: input.linuxPid,
    processResourceId: input.processResourceId,
    syntheticProcessId: input.processId
  })

/** Owns Android Policy, Broker, Providers, resources, and plugin scopes in the Host plugin Realm. */
export const createAndroidCapabilityHostRuntime = (host, pluginGraphRevision = 0) => {
  const source = host.capabilityConfiguration()
  if (source == null) return null
  const envelope = JSON.parse(source)
  const session = envelope.session
  const creation = session.runtimeCreation
  const providers = new Map([...PROVIDERS].map(module => [module, createAndroidHostProviderV1(host, module)]))
  const resolved = new Map([
    [creation.hostBindings.engineGate.bindingId, Object.freeze({ kind: 'android.engine-gate' })],
    [creation.hostBindings.initialMiddlewareSet.bindingId, initialMiddleware(session.initialMiddleware)],
    [creation.hostBindings.moduleResolver.bindingId, Object.freeze({ kind: 'android.module-resolver' })]
  ])
  for (const registration of creation.hostBindings.providerBindings) {
    const provider = providers.get(registration.module)
    if (provider != null) resolved.set(registration.providerId, provider)
  }
  const admitted = admitRuntimeCreationV1(creation, {
    expectedOwnerId: session.ownerId,
    generation: envelope.generation,
    processId: session.processId,
    resolveBinding: reference => resolved.get(reference.bindingId)
  })
  const kernel = new CapabilityRuntimeInvocationKernelV1({
    admitted,
    engine: 'android-javet-v8',
    networkProvider: session.providerConfiguration?.networkProvider ?? 'host.network',
    requestPrefix: 'android',
    target: 'android'
  })
  const linuxFilesystem = new LinuxFilesystemCapabilityBridgeV1()
    .bind(input => Promise.resolve(kernel.invokeFromSourceImmediate(input)))
  const linuxProcessNetwork = new LinuxProcessNetworkCapabilityBridgeV1()
    .bind(input => Promise.resolve(kernel.invokeFromSourceImmediate(input)))
  const linuxProcessExecution = new LinuxProcessExecutionCapabilityBridgeV1()
    .bind(input => kernel.invokeFromSource(input))
  const linuxCapability = input => {
    const operation = linuxCapabilityOperation(input.command)
    if (operation == null || operation.kind === 'subscribe') {
      throw new CapabilityInvocationError('provider.unavailable', 'runtime.linux-capability')
    }
    return kernel.invokeFromSource({
      arguments: Object.freeze({}),
      member: operation.member,
      mode: operation.modes[0],
      module: operation.module,
      source: linuxCapabilitySource(input)
    })
  }
  return Object.freeze({
    cancel: json => kernel.cancel(json),
    close: () => kernel.close(),
    createPluginInterceptorScope: instanceId => kernel.createPluginInterceptorScope(instanceId),
    invoke: (json, signal) => kernel.invoke(json, signal),
    invokeFromSource: (channel, input) => {
      if (channel === 'linuxFilesystem') return linuxFilesystem.dispatch(input)
      if (channel === 'linuxProcessNetwork') return linuxProcessNetwork.authorize(input)
      if (channel === 'linuxProcessExecution') return linuxProcessExecution.authorize(input)
      if (channel === 'linuxCapability') return linuxCapability(input)
      throw new CapabilityInvocationError('provider.unavailable', 'runtime.trusted-backend')
    },
    invokeImmediate: json => kernel.invokeImmediate(json),
    invokeSync: json => kernel.invokeSync(json),
    pluginGraphRevision,
    publishPluginGraph: (revision, scopes) => kernel.publishPluginGraph(revision, scopes),
    releaseResource: bindingId => kernel.releaseResource(bindingId),
    subscribeResource: (bindingId, listener) =>
      kernel.subscribeResource(bindingId, event => listener(JSON.stringify(event)))
  })
}
