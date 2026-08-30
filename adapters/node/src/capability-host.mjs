// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import {
  CapabilityInvocationError,
  CapabilityRuntimeInvocationKernelV1,
  admitRuntimeCreationV1
} from '../../../dist/capability-runtime/index.js'

import { createInstalledV86ProcessBackendRuntimeV1 } from './capability-process-v86-installation.mjs'
import { createNodeCapabilityProvidersV1 } from './capability-providers.mjs'

const initialMiddleware = configuration => {
  const behavior = configuration.behavior
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
      matcher: configuration.matcher ?? Object.freeze({}),
      middleware,
      registrationId: 'node.initial',
      ...(configuration.timeoutMs == null ? {} : { timeoutMs: configuration.timeoutMs })
    })]),
    schemaVersion: 1
  })
}

const resolveBindings = (session, providers) => {
  const bindings = session.runtimeCreation.hostBindings
  const resolved = new Map([
    [bindings.engineGate.bindingId, Object.freeze({ kind: 'node.engine-gate' })],
    [bindings.initialMiddlewareSet.bindingId, initialMiddleware(session.initialMiddleware)],
    [bindings.moduleResolver.bindingId, Object.freeze({ kind: 'node.module-resolver' })]
  ])
  for (const registration of bindings.providerBindings) {
    const provider = providers.get(registration.module)
    if (provider != null) resolved.set(registration.providerId, provider)
  }
  return resolved
}

export class NodeCapabilityRuntimeHostV1 {
  #abortControllers = new Map()
  #generation
  #kernel
  #providers
  #session

  constructor({ generation, session }) {
    this.#generation = generation
    this.#session = session
    const processBackendRuntime = session.providerConfiguration.processBackendInstallation == null
      ? undefined
      : createInstalledV86ProcessBackendRuntimeV1(
        session.providerConfiguration.processBackendInstallation,
        {
          capabilityBridge: session.providerConfiguration.processProfile?.environment.capabilityBridge
        }
      )
    this.#providers = createNodeCapabilityProvidersV1(
      session,
      generation,
      processBackendRuntime?.registry
    )
    const resolved = resolveBindings(session, this.#providers)
    const admitted = admitRuntimeCreationV1(session.runtimeCreation, {
      expectedOwnerId: session.ownerId,
      generation,
      processId: session.processId,
      resolveBinding: reference => resolved.get(reference.bindingId)
    })
    this.#kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted,
      engine: 'node-vm',
      networkProvider: session.providerConfiguration.networkProvider,
      requestPrefix: 'node',
      target: 'node'
    })
    processBackendRuntime?.bind(input => this.#kernel.invokeFromSource(input))
  }

  async close(stale = false) {
    for (const controller of this.#abortControllers.values()) controller.abort()
    this.#abortControllers.clear()
    this.#kernel.close(stale)
    await Promise.allSettled(
      [...this.#providers.values()].map(provider => provider.close?.())
    )
  }

  configuration() {
    const configuration = this.#session.runtimeCreation.configuration
    const processFields = ['process.cwd', 'process.env', 'process.execPath', 'process.pid']
    const processEnabled = processFields.every(field =>
      configuration.systemProjection.fields[field] != null &&
      configuration.sandboxPolicy.systemInformation.fields[field] != null
    )
    return JSON.stringify({
      admissionDigest: this.#kernel.admissionDigest,
      context: configuration.context.guest ?? null,
      generation: this.#generation,
      networkProvider: this.#session.providerConfiguration.networkProvider,
      processEnvironment: this.#session.providerConfiguration.processProfile?.environment,
      processShellExecutableId: this.#session.providerConfiguration.processProfile?.defaultShellExecutableId,
      processEnabled
    })
  }

  invoke(json, cancellationId, initiallyAborted, callback) {
    if (
      typeof callback !== 'function' || typeof initiallyAborted !== 'boolean' ||
      cancellationId != null && (
          typeof cancellationId !== 'string' || !/^[A-Za-z0-9][\w.-]{0,127}$/u.test(cancellationId) ||
          this.#abortControllers.has(cancellationId) || this.#abortControllers.size >= 4096
        )
    ) return false
    const controller = cancellationId == null ? undefined : new AbortController()
    if (controller != null) {
      this.#abortControllers.set(cancellationId, controller)
      if (initiallyAborted) controller.abort()
    }
    void this.#kernel.invoke(json, controller?.signal).then(callback).finally(() => {
      if (cancellationId != null) this.#abortControllers.delete(cancellationId)
    })
    return true
  }

  abort(cancellationId) {
    const controller = this.#abortControllers.get(cancellationId)
    if (controller == null) return false
    controller.abort()
    return true
  }

  invokeImmediate(json) {
    return this.#kernel.invokeImmediate(json)
  }

  invokeSync(json) {
    return this.#kernel.invokeSync(json)
  }

  networkResolution(bindingId, url) {
    const module = this.#session.providerConfiguration.networkProvider
    const provider = this.#providers.get(module)
    if (typeof provider?.resolution !== 'function') {
      throw Object.assign(new Error('Node capability network resolution is unavailable'), { code: 'dns_failed' })
    }
    return provider.resolution(bindingId, url)
  }

  releaseResource(bindingId) {
    try {
      this.#kernel.releaseResource(bindingId)
      return true
    } catch {
      return false
    }
  }

  createPluginInterceptorScope(instanceId) {
    return this.#kernel.createPluginInterceptorScope(instanceId)
  }

  publishPluginGraph(revision, scopes) {
    this.#kernel.publishPluginGraph(revision, scopes)
  }

  drainPluginGraph(revision) {
    return this.#kernel.drainPluginGraph(revision)
  }

  subscribeResource(bindingId, callback) {
    try {
      return this.#kernel.subscribeResource(bindingId, event => callback(JSON.stringify(event)))
    } catch {
      return null
    }
  }
}
