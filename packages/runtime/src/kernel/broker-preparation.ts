import { createProviderAuthorityV1 } from './broker-authority.js'
import { matchesHoloInvocationV1 } from './broker-matcher.js'
import { authorizeCapabilityInvocationV1 } from './broker-policy.js'
import { createProviderResolutionAdmitterV1 } from './broker-resolution.js'
import { createLinkedCapabilitySignalV1, resolveCapabilityProviderV1 } from './broker-support.js'
import type {
  CapabilityBrokerInvocationV1,
  CapabilityProviderTerminalV1,
  CapabilityRuntimeTargetV1,
  HoloInvocationContextV1,
  HoloMiddlewareRegistrationV1,
  InitialMiddlewareSetV1
} from './broker-types.js'
import { validateBrokerArgumentsV1, validateBrokerResultV1 } from './broker-validation.js'
import { isTrustedInvocationValueV1 } from './broker-values.js'
import type { TrustedInvocationValueV1 } from './broker-values.js'
import { validateCanonicalResourceV1 } from './canonical-resource-validation.js'
import type { AdmittedRuntimeCreationV1 } from './context-types.js'
import { CapabilityInvocationError, capabilityFailure } from './errors.js'
import type { RuntimeInterceptorRegistryV1 } from './interceptor-registry.js'
import { normalizeCapabilityInvocationSourceV1 } from './invocation-source.js'
import { OPERATION_REGISTRY_V1 } from './operation-registry.js'
import type { CapabilityResourceRegistryV1 } from './resource-registry.js'

export interface CapabilityBrokerPreparationOptionsV1<THostContext> {
  readonly admitted: AdmittedRuntimeCreationV1
  readonly controller: AbortController
  readonly engine: string
  readonly initial: InitialMiddlewareSetV1<THostContext>
  readonly interceptors: RuntimeInterceptorRegistryV1<THostContext>
  readonly policyDigest: string
  readonly resources: CapabilityResourceRegistryV1
  readonly system: readonly HoloMiddlewareRegistrationV1<THostContext>[]
  readonly target: CapabilityRuntimeTargetV1
}

export const prepareCapabilityBrokerInvocationV1 = <THostContext>(
  options: CapabilityBrokerPreparationOptionsV1<THostContext>,
  invocation: CapabilityBrokerInvocationV1
) => {
  if (options.controller.signal.aborted) {
    const reason = options.controller.signal.reason
    if (reason instanceof CapabilityInvocationError) throw reason
    capabilityFailure('runtime.generation_stale', 'runtime.lifecycle')
  }
  if (!isTrustedInvocationValueV1(invocation.arguments, 'argument')) {
    capabilityFailure('argument.invalid', `${invocation.module}.${invocation.member}`)
  }
  if (invocation.providerData != null && !isTrustedInvocationValueV1(invocation.providerData, 'argument')) {
    capabilityFailure('argument.invalid', `${invocation.module}.${invocation.member}`)
  }
  const descriptor =
    OPERATION_REGISTRY_V1.find(row =>
      row.module === invocation.module && row.member === invocation.member &&
      row.modes.includes(invocation.invocationMode)
    ) ?? capabilityFailure('argument.invalid', `${invocation.module}.${invocation.member}`)
  const resource = validateCanonicalResourceV1(invocation.resource)
  const source = invocation.source == null ? undefined : normalizeCapabilityInvocationSourceV1(invocation.source)
  const resultSchemaId = validateBrokerArgumentsV1(
    descriptor,
    invocation.arguments.value,
    resource.semanticResourceDigest
  )
  const inherited = invocation.inheritedBindingId == null
    ? undefined
    : options.resources.get(invocation.inheritedBindingId)
  if (
    inherited != null && descriptor.operation !== 'network.fetch.redirect' &&
    inherited.resource.semanticResourceDigest !== resource.semanticResourceDigest
  ) capabilityFailure('resource.invalid', descriptor.operation, resource.semanticResourceDigest)
  const inheritedCapability = 'kind' in descriptor.capability && descriptor.capability.kind === 'inherited'
  if (inheritedCapability && inherited == null) {
    capabilityFailure('capability.denied', descriptor.operation, resource.semanticResourceDigest)
  }
  const selection = inheritedCapability
    ? inherited!.selection
    : authorizeCapabilityInvocationV1({
      arguments: invocation.arguments,
      context: {
        generation: options.admitted.generation,
        policyDigest: options.policyDigest,
        principal: options.admitted.principal,
        processId: options.admitted.processId
      },
      descriptor,
      deviceProviderDescriptor: options.admitted.configuration.deviceProviderDescriptor,
      policy: options.admitted.configuration.sandboxPolicy,
      preferredProviderModule: invocation.preferredProviderModule,
      resource,
      systemProjection: options.admitted.configuration.systemProjection
    })
  const providerModules = inheritedCapability
    ? [inherited!.providerModule]
    : [...new Set(selection.authorityBindings.map(item => item.providerModule))]
  if (providerModules.length !== 1 || inherited != null && inherited.providerModule !== providerModules[0]) {
    capabilityFailure('capability.denied', descriptor.operation, resource.semanticResourceDigest)
  }
  const providerModule = providerModules[0]!
  const provider = resolveCapabilityProviderV1<THostContext>(options.admitted, providerModule)
  const linked = createLinkedCapabilitySignalV1(options.controller.signal, invocation.signal)
  const providerAuthority = createProviderAuthorityV1({
    descriptor,
    generation: options.admitted.generation,
    processId: options.admitted.processId,
    providerModule,
    requestId: invocation.requestId,
    resource,
    selection,
    signal: linked.signal
  })
  const context: HoloInvocationContextV1<THostContext> = Object.freeze({
    arguments: invocation.arguments.value,
    authorityBindings: selection.authorityBindings,
    capabilities: selection.bindings,
    hostContext: options.admitted.configuration.context.host as Readonly<THostContext>,
    invocationMode: invocation.invocationMode,
    kind: descriptor.kind,
    member: descriptor.member,
    module: descriptor.module,
    operation: descriptor.operation,
    phase: 'requested',
    ...(invocation.providerData == null ? {} : { providerData: invocation.providerData.value }),
    requestId: invocation.requestId,
    resource: Object.freeze({
      binding: providerAuthority.authority.invocationBinding,
      ...(invocation.inheritedBindingId == null ? {} : { inheritedBindingId: invocation.inheritedBindingId }),
      requested: resource
    }),
    runtime: Object.freeze({
      engine: options.engine,
      generation: options.admitted.generation,
      policyDigest: options.policyDigest,
      processId: options.admitted.processId,
      target: options.target
    }),
    signal: linked.signal,
    ...(source == null ? {} : { source }),
    state: new Map()
  })
  const terminalOwners = [providerAuthority.owns]
  const resolution = createProviderResolutionAdmitterV1({
    arguments: invocation.arguments,
    context,
    descriptor,
    options,
    providerModule,
    registerTerminalOwner: owner => terminalOwners.push(owner),
    selection
  })
  const interceptorSnapshot = options.interceptors.acquireSnapshot()
  const middleware = Object.freeze([
    ...options.system,
    ...(descriptor.interception === 'host' ? options.initial.registrations : []),
    ...(descriptor.interception === 'host' ? interceptorSnapshot.registrations : [])
  ].filter(item => matchesHoloInvocationV1(item.matcher, context)))
  let terminal: CapabilityProviderTerminalV1 | undefined
  return {
    abort: linked.abort,
    authority: providerAuthority.authority,
    cleanup: () => {
      linked.cleanup()
      interceptorSnapshot.release()
    },
    context,
    inheritedBindingId: invocation.inheritedBindingId,
    middleware,
    ownsTerminal: (candidate: CapabilityProviderTerminalV1) => {
      const owned = terminalOwners.some(owner => owner(candidate))
      if (owned) terminal = candidate
      return owned
    },
    provider,
    providerModule,
    providerTimeoutMs: resource.kind === 'network' &&
        options.admitted.configuration.sandboxPolicy.network.access !== 'none'
      ? options.admitted.configuration.sandboxPolicy.network.limits.socketTimeoutMs
      : 120_000,
    resolution,
    releaseBindingId: descriptor.kind === 'close' ? invocation.inheritedBindingId : undefined,
    selection,
    get terminal() {
      return terminal
    },
    validate: (result: TrustedInvocationValueV1) =>
      validateBrokerResultV1(
        descriptor,
        result.value,
        resource.semanticResourceDigest,
        resultSchemaId
      )
  }
}
