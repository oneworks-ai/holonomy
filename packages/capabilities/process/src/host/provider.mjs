import { assertProcessAuthorityV1 } from './authority.mjs'
import { authorizeProcessDescendantV1 } from './descendant.mjs'
import { processNetworkPreflightV1 } from './network-preflight.mjs'
import { ProcessResourceManagerV1 } from './resources.mjs'
import { exactEnvironment } from './support.mjs'
import { spawnProcessSyncV1 } from './sync.mjs'

// ProcessHostPortV1 owns Backend I/O; this Provider owns policy, authority and
// the only process resource/event ledger. No platform object crosses to Guest.
export class ProcessProviderV1 {
  execution = 'sync'
  module = 'host.process'
  #contracts
  #manifest
  #policy
  #profile
  #resources
  #generation
  #port

  constructor(profile, policy, generation, port, contracts) {
    if (
      port == null || typeof port.prepareLaunch !== 'function' ||
      typeof port.spawn !== 'function' || typeof port.closeGeneration !== 'function' ||
      typeof port.byteLengthUtf8 !== 'function' || typeof port.decodeInput !== 'function' ||
      typeof port.describeOutput !== 'function' || port.descriptor == null
    ) {
      throw new TypeError('ProcessHostPortV1 is unavailable')
    }
    this.#contracts = contracts
    this.#port = port
    this.#manifest = new Map(profile.executables.map(item => [item.executableId, item]))
    this.#generation = generation
    this.#policy = policy
    this.#profile = profile
    this.#resources = new ProcessResourceManagerV1(policy, port, contracts)
  }

  async close() {
    this.#resources.close()
    await this.#port.closeGeneration(this.#generation)
  }

  poll() {
    // Desktop's existing resource-subscriptions drain calls this on the Host
    // thread. The port synchronously dispatches ordered native events to its
    // registered sinks; Process publications remain Kernel-owned until release.
    this.#port.poll?.()
    return []
  }

  invoke(context, authority) {
    const { CapabilityInvocationError } = this.#contracts
    const resource = context.resource.requested
    if (resource.kind === 'processNetworkEndpoint') {
      throw new CapabilityInvocationError('provider.protocol_error', context.operation)
    }
    if (context.member === 'authorizeDescendantProcess') {
      return authorizeProcessDescendantV1({
        authority,
        context,
        contracts: this.#contracts,
        manifest: this.#manifest,
        policy: this.#policy,
        port: this.#port,
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
    return processNetworkPreflightV1({
      authority,
      context,
      contracts: this.#contracts,
      generation: this.#generation,
      policy: this.#policy,
      port: this.#port
    })
  }

  #spawn(context, authority, resource) {
    const { CapabilityInvocationError, trustedInvocationValueFromJsonV1 } = this.#contracts
    if (this.#policy.access !== 'sandboxed') {
      throw new CapabilityInvocationError('policy.denied', context.operation)
    }
    const executableId = resource.invocation === 'program'
      ? resource.executableId
      : resource.shellExecutableId
    if (resource.invocation === 'shell' && this.#port.descriptor.features.shell !== true) {
      throw new CapabilityInvocationError('provider.unavailable', context.operation)
    }
    const authorityProcessLimit = assertProcessAuthorityV1(
      context,
      authority,
      executableId,
      undefined,
      CapabilityInvocationError
    )
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
    const argumentBytes = commandArgs.reduce((sum, value) => sum + this.#port.byteLengthUtf8(value), 0)
    const executablePolicy = this.#policy.executables.find(item => item.executableId === executableId)
    if (executablePolicy == null || argumentBytes > executablePolicy.argumentBytes) {
      throw new CapabilityInvocationError('policy.denied', context.operation)
    }
    if (options.cwd != null) throw new CapabilityInvocationError('policy.denied', context.operation)
    const environment = exactEnvironment(
      this.#policy.environment,
      options.env,
      this.#port,
      CapabilityInvocationError
    )
    const stdio = options.stdio ?? ['pipe', 'pipe', 'pipe']
    const launch = this.#port.prepareLaunch({
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
      if (
        this.#port.descriptor.features.synchronousSpawn !== true ||
        typeof this.#port.spawnSync !== 'function'
      ) {
        throw new CapabilityInvocationError('provider.unavailable', context.operation)
      }
      this.#resources.reserveSync(context.operation, stdio, authorityProcessLimit)
      return authority.complete(trustedInvocationValueFromJsonV1(
        spawnProcessSyncV1({
          context,
          contracts: this.#contracts,
          env: environment,
          launch,
          options,
          policy: this.#policy,
          port: this.#port,
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
