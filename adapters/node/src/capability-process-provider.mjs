import { Buffer } from 'node:buffer'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError, trustedInvocationValueFromJsonV1 } from '../../../dist/capability-runtime/index.js'

import { NODE_PROCESS_BACKEND_REGISTRY_V1 } from './capability-process-backend.mjs'
import { authorizeNodeProcessDescendantV1 } from './capability-process-descendant.mjs'
import { createNodeProcessNetworkResolutionV1 } from './capability-process-network-resolution.mjs'
import { NodeProcessResourceManagerV1 } from './capability-process-resources.mjs'
import { exactEnvironment } from './capability-process-support.mjs'
import { spawnNodeProcessSyncV1 } from './capability-process-sync.mjs'
import { assertNodeProcessAuthorityV1, assertNodeProcessNetworkAuthorityV1 } from './capability-provider-authority.mjs'

export class NodeProcessProviderV1 {
  execution = 'sync'
  module = 'host.process'
  #manifest
  #policy
  #profile
  #resources
  #generation
  #networkResolutionOptions

  #backend

  constructor(profile, policy, generation, registry = NODE_PROCESS_BACKEND_REGISTRY_V1, options = {}) {
    this.#backend = registry.get(profile.backend.backendId)
    if (this.#backend == null) throw new TypeError('Node Process Backend is unavailable')
    this.#manifest = new Map(profile.executables.map(item => [item.executableId, item]))
    this.#generation = generation
    this.#policy = policy
    this.#profile = profile
    this.#networkResolutionOptions = options.networkResolution ?? {}
    this.#resources = new NodeProcessResourceManagerV1(policy, this.#backend)
  }

  async close() {
    this.#resources.close()
    await this.#backend.closeGeneration(this.#generation)
  }

  invoke(context, authority) {
    const resource = context.resource.requested
    if (resource.kind === 'processNetworkEndpoint') {
      throw new CapabilityInvocationError('provider.protocol_error', context.operation)
    }
    if (context.member === 'authorizeDescendantProcess') {
      return authorizeNodeProcessDescendantV1({
        authority,
        context,
        manifest: this.#manifest,
        policy: this.#policy,
        profile: this.#profile,
        resource,
        resources: this.#resources
      })
    }
    if (resource.kind === 'processExecutable') return this.#spawn(context, authority, resource)
    if (resource.kind !== 'processInstance') {
      throw new CapabilityInvocationError('resource.invalid', context.operation)
    }
    return this.#resources.invoke(context, authority, resource)
  }

  preflight(context, authority) {
    const resource = context.resource.requested
    if (resource.kind !== 'processNetworkEndpoint') return undefined
    assertNodeProcessNetworkAuthorityV1(context, authority)
    if (this.#policy.access !== 'sandboxed' || this.#policy.network.access !== 'restricted') {
      throw new CapabilityInvocationError('policy.denied', context.operation)
    }
    return createNodeProcessNetworkResolutionV1({
      context,
      generation: this.#generation,
      policy: this.#policy,
      ...this.#networkResolutionOptions
    }).then(resolution =>
      Object.freeze({
        execute: (resolvedContext, authorities) => {
          const resolvedAuthority = authorities[0]
          if (resolvedAuthority == null) {
            throw new CapabilityInvocationError('provider.protocol_error', context.operation)
          }
          return resolvedAuthority.complete(trustedInvocationValueFromJsonV1({
            authorized: true,
            generation: resolvedContext.runtime.generation,
            invocationBindingDigest: resolvedAuthority.invocationBinding.invocationBindingDigest,
            resolution: resolution.receipt,
            semanticResourceDigest: resource.semanticResourceDigest
          }, 'result'))
        },
        requests: Object.freeze([Object.freeze({
          evidence: resolution.evidence,
          reason: 'networkAddress',
          resolved: resource,
          sideEffectCount: 0,
          verify: resolution.verify
        })])
      })
    )
  }

  #spawn(context, authority, resource) {
    if (this.#policy.access !== 'sandboxed') {
      throw new CapabilityInvocationError('policy.denied', context.operation)
    }
    const executableId = resource.invocation === 'program'
      ? resource.executableId
      : resource.shellExecutableId
    if (resource.invocation === 'shell' && this.#backend.descriptor.features.shell !== true) {
      throw new CapabilityInvocationError('provider.unavailable', context.operation)
    }
    const authorityProcessLimit = assertNodeProcessAuthorityV1(context, authority, executableId)
    const executable = this.#manifest.get(executableId)
    if (executable == null || resource.invocation === 'shell' && executable.shell !== true) {
      throw new CapabilityInvocationError('provider.unavailable', context.operation)
    }
    const args = context.arguments
    const options = args.options ?? {}
    if (
      resource.environmentScope !== args.environmentScope ||
      !this.#profile.environment.allowedScopes.includes(resource.environmentScope)
    ) throw new CapabilityInvocationError('policy.denied', context.operation)
    const commandArgs = resource.invocation === 'program'
      ? [...executable.fixedArgs, ...(args.args ?? [])]
      : [...executable.fixedArgs, '-c', args.command]
    const argumentBytes = commandArgs.reduce((sum, value) => sum + Buffer.byteLength(value), 0)
    const executablePolicy = this.#policy.executables.find(item => item.executableId === executableId)
    if (executablePolicy == null || argumentBytes > executablePolicy.argumentBytes) {
      throw new CapabilityInvocationError('policy.denied', context.operation)
    }
    if (options.cwd != null) throw new CapabilityInvocationError('policy.denied', context.operation)
    const environment = exactEnvironment(this.#policy.environment, options.env)
    const stdio = options.stdio ?? ['pipe', 'pipe', 'pipe']
    const launch = this.#backend.prepareLaunch({
      configuration: this.#profile.backend.configuration,
      executables: this.#profile.executables,
      environmentScope: resource.environmentScope,
      executable: executable.executable,
      executableId,
      generation: context.runtime.generation,
      operation: context.operation,
      policy: this.#policy,
      runtimeArgs: commandArgs
    })
    if (context.member.endsWith('Sync')) {
      if (this.#backend.descriptor.features.synchronousSpawn !== true) {
        throw new CapabilityInvocationError('provider.unavailable', context.operation)
      }
      this.#resources.reserveSync(context.operation, stdio, authorityProcessLimit)
      return authority.complete(trustedInvocationValueFromJsonV1(
        spawnNodeProcessSyncV1({
          backend: this.#backend,
          context,
          env: environment,
          launch,
          options,
          policy: this.#policy,
          resources: this.#resources,
          stdio
        }),
        'result'
      ))
    }
    return this.#resources.spawn(
      context,
      authority,
      resource,
      executableId,
      launch,
      environment,
      stdio,
      options,
      authorityProcessLimit
    )
  }
}
