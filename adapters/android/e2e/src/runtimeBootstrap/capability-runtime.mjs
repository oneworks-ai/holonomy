import {
  CapabilityInvocationError,
  CapabilityRuntimeInvocationKernelV1,
  LinuxFilesystemCapabilityBridgeV1,
  LinuxProcessNetworkCapabilityBridgeV1,
  admitRuntimeCreationV1,
  createCapabilityFetchV1,
  createCapabilityModuleOverridesV1,
  trustedInvocationValueFromJsonV1
} from './modules/capability-runtime/index.js'

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

const hostProvider = (host, module) =>
  Object.freeze({
    execution: 'sync',
    module,
    invoke(context, authority) {
      const source = host.capabilityInvokeSync(JSON.stringify({
        arguments: context.arguments,
        authorityBindings: authority.bindings,
        generation: context.runtime.generation,
        inheritedBindingId: context.resource.inheritedBindingId,
        invocationBinding: context.resource.binding,
        invocationMode: context.invocationMode,
        member: context.member,
        module: context.module,
        operation: context.operation,
        providerData: context.providerData,
        providerModule: module,
        resource: context.resource.requested,
        source: context.source
      }))
      const terminal = JSON.parse(source)
      if (terminal.ok !== true) {
        throw new CapabilityInvocationError(
          terminal.error?.code ?? 'provider.unavailable',
          context.operation,
          context.resource.requested.semanticResourceDigest
        )
      }
      const facade = terminal.value
      const publication = Array.isArray(terminal.resources)
        ? terminal.resources.map(resource => ({
          bindingId: resource.bindingId,
          close: () => host.capabilityReleaseResource(resource.bindingId),
          resource: context.resource.requested,
          resourceType: resource.resourceType,
          ...(typeof resource.eventSchemaId !== 'string' ? {} : {
            eventSchemaId: resource.eventSchemaId,
            subscribe: listener => {
              const subscriptionId = host.capabilitySubscribeResource(
                resource.bindingId,
                eventJson => listener(trustedInvocationValueFromJsonV1(JSON.parse(eventJson), 'result'))
              )
              if (typeof subscriptionId !== 'string') return () => undefined
              return () => host.capabilityUnsubscribeResource(subscriptionId)
            }
          })
        }))
        : []
      return authority.complete(trustedInvocationValueFromJsonV1(facade, 'result'), publication)
    }
  })

export const createAndroidCapabilityRuntime = (host) => {
  const source = host.capabilityConfiguration()
  if (source == null) return null
  const envelope = JSON.parse(source)
  const session = envelope.session
  const creation = session.runtimeCreation
  const providers = new Map([...PROVIDERS].map(module => [module, hostProvider(host, module)]))
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
  const bridge = Object.freeze({
    invoke: json => kernel.invoke(json),
    invokeImmediate: json => kernel.invokeSync(json),
    invokeSync: json => kernel.invokeSync(json),
    releaseResource: bindingId => kernel.releaseResource(bindingId),
    subscribeResource: (bindingId, listener) => kernel.subscribeResource(bindingId, listener)
  })
  const linuxFilesystem = new LinuxFilesystemCapabilityBridgeV1()
    .bind(input => kernel.invokeFromSource(input))
  const linuxProcessNetwork = new LinuxProcessNetworkCapabilityBridgeV1()
    .bind(input => kernel.invokeFromSource(input))
  return Object.freeze({
    close: () => kernel.close(),
    configuration: Object.freeze({ context: admitted.configuration.context.guest ?? null }),
    fetch: value => createCapabilityFetchV1(value, bridge),
    linuxFilesystem: Object.freeze({
      dispatch: input => linuxFilesystem.dispatch(input)
    }),
    linuxProcessNetwork: Object.freeze({
      authorize: input => linuxProcessNetwork.authorize(input)
    }),
    moduleOverrides: createCapabilityModuleOverridesV1(
      { context: admitted.configuration.context.guest ?? null },
      bridge
    )
  })
}
