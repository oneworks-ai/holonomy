import { canonicalizeProcessInstanceResource } from '@holonomyjs/capability-process'
import {
  CapabilityInvocationError,
  canonicalizeFilesystemResource,
  trustedInvocationValueFromJsonV1
} from '@holonomyjs/runtime/kernel'

const monotonicNow = globalThis.performance?.now?.bind(globalThis.performance) ?? Date.now.bind(Date)

const providerRequest = (context, authority, module, extra = {}) =>
  JSON.stringify({
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
    requestId: context.requestId,
    resource: context.resource.resolved ?? context.resource.requested,
    source: context.source,
    ...extra
  })

const callHost = (host, context, authority, module, extra) => {
  const terminal = JSON.parse(host.capabilityInvokeSync(providerRequest(context, authority, module, extra)))
  if (terminal.ok !== true) {
    throw new CapabilityInvocationError(
      terminal.error?.code ?? 'provider.unavailable',
      context.operation,
      context.resource.requested.semanticResourceDigest
    )
  }
  return terminal
}

const publicationFromHost = (host, context, resources) =>
  resources.map(resource => ({
    bindingId: resource.bindingId,
    close: () => host.capabilityReleaseResource(resource.bindingId),
    resource: resource.processInstance == null
      ? context.resource.resolved ?? context.resource.requested
      : canonicalizeProcessInstanceResource(resource.processInstance),
    resourceType: resource.resourceType,
    ...(typeof resource.eventSchemaId !== 'string' ? {} : {
      eventSchemaId: resource.eventSchemaId,
      subscribe: listener => {
        const source = host.capabilitySubscribeResource(
          resource.bindingId,
          eventJson => listener(trustedInvocationValueFromJsonV1(JSON.parse(eventJson), 'result'))
        )
        if (typeof source !== 'string') return () => undefined
        const subscription = JSON.parse(source)
        if (!Array.isArray(subscription.initialEvents) || typeof subscription.subscriptionId !== 'string') {
          return () => undefined
        }
        for (const event of subscription.initialEvents) {
          listener(trustedInvocationValueFromJsonV1(event, 'result'))
        }
        return () => host.capabilityUnsubscribeResource(subscription.subscriptionId)
      }
    })
  }))

export const createAndroidHostProviderV1 = (host, module) =>
  Object.freeze({
    execution: 'sync',
    invoke(context, authority) {
      const terminal = callHost(host, context, authority, module)
      const publication = Array.isArray(terminal.resources)
        ? publicationFromHost(host, context, terminal.resources)
        : []
      const result = trustedInvocationValueFromJsonV1(terminal.value, 'result')
      return authority.complete(result, publication)
    },
    module,
    preflight(context, authority) {
      const filesystem = module === 'host.fs'
      const network = module === 'host.network' && context.operation === 'network.fetch.request'
      const processNetwork = module === 'host.process' && context.operation === 'process.network.connect'
      if ((!filesystem && !network && !processNetwork) || context.resource.inheritedBindingId != null) return undefined
      const terminal = callHost(host, context, authority, module, {
        ...(network || processNetwork ? { brokerMonotonicMs: monotonicNow() } : {}),
        providerPhase: 'preflight'
      })
      if (!Array.isArray(terminal.value?.requests) || terminal.value.requests.length < 1) {
        throw new CapabilityInvocationError('provider.protocol_error', context.operation)
      }
      const requests = terminal.value.requests.map((request, resolutionIndex) => {
        const resolved = filesystem
          ? canonicalizeFilesystemResource(request.resolvedVirtualUrl, context.resource.requested.display.label)
          : context.resource.requested
        return Object.freeze({
          evidence: request.evidence,
          reason: request.reason,
          resolved,
          sideEffectCount: request.sideEffectCount,
          verify: () => {
            const verification = callHost(host, context, authority, module, {
              providerPhase: 'verify',
              resolutionIndex
            }).value
            return Object.freeze({
              evidence: verification.evidence,
              resolved: filesystem
                ? canonicalizeFilesystemResource(
                  verification.resolvedVirtualUrl,
                  context.resource.requested.display.label
                )
                : context.resource.requested
            })
          }
        })
      })
      return Object.freeze({
        dispose: () => callHost(host, context, authority, module, { providerPhase: 'cancel' }),
        execute(resolvedContext, authorities, tokens) {
          const terminal = callHost(host, resolvedContext, authorities[0], module, {
            providerPhase: 'execute',
            resolutionAuthorityBindings: authorities.map(item => item.bindings),
            resolutionResources: requests.map(item => item.resolved),
            resolutionTokens: tokens
          })
          const publication = Array.isArray(terminal.resources)
            ? publicationFromHost(host, resolvedContext, terminal.resources)
            : []
          return authorities[0].complete(
            trustedInvocationValueFromJsonV1(terminal.value, 'result'),
            publication
          )
        },
        requests: Object.freeze(requests)
      })
    }
  })
