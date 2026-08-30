import { Buffer } from 'node:buffer'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError, trustedInvocationValueFromJsonV1 } from '../../../dist/capability-runtime/index.js'

import { NODE_PROCESS_BACKEND_REGISTRY_V1 } from './capability-process-backend.mjs'
import { authorizeNodeProcessDescendantV1 } from './capability-process-descendant.mjs'
import { NodeProcessResourceManagerV1 } from './capability-process-resources.mjs'
import { binary, exactEnvironment, nodeError } from './capability-process-support.mjs'
import { assertNodeProcessAuthorityV1, assertNodeProcessNetworkAuthorityV1 } from './capability-provider-authority.mjs'

export class NodeProcessProviderV1 {
  execution = 'sync'
  module = 'host.process'
  #manifest
  #policy
  #profile
  #resources
  #generation

  #backend

  constructor(profile, policy, generation, registry = NODE_PROCESS_BACKEND_REGISTRY_V1) {
    this.#backend = registry.get(profile.backend.backendId)
    if (this.#backend == null) throw new TypeError('Node Process Backend is unavailable')
    this.#manifest = new Map(profile.executables.map(item => [item.executableId, item]))
    this.#generation = generation
    this.#policy = policy
    this.#profile = profile
    this.#resources = new NodeProcessResourceManagerV1(policy, this.#backend)
  }

  async close() {
    this.#resources.close()
    await this.#backend.closeGeneration(this.#generation)
  }

  invoke(context, authority) {
    const resource = context.resource.requested
    if (resource.kind === 'processNetworkEndpoint') {
      assertNodeProcessNetworkAuthorityV1(context, authority)
      return authority.complete(trustedInvocationValueFromJsonV1({
        authorized: true,
        generation: context.runtime.generation,
        invocationBindingDigest: authority.invocationBinding.invocationBindingDigest,
        semanticResourceDigest: resource.semanticResourceDigest
      }, 'result'))
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
        this.#spawnSync(context, launch, environment, stdio, options),
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

  #spawnSync(context, launch, env, stdio, options) {
    const result = this.#backend.spawnSync(launch, {
      cwd: launch.cwd,
      encoding: options.encoding === 'utf8' ? 'utf8' : 'buffer',
      env,
      killSignal: 'SIGKILL',
      maxBuffer: Math.min(
        options.maxBufferBytes ?? this.#policy.limits.maxStdoutBytes,
        this.#policy.limits.maxStdoutBytes,
        this.#policy.limits.maxStderrBytes
      ),
      shell: false,
      stdio,
      timeout: Math.min(
        options.timeoutMs ?? this.#policy.limits.maxExecutionTimeMs,
        this.#policy.limits.maxExecutionTimeMs
      )
    })
    const output = stream =>
      options.encoding === 'utf8'
        ? stream ?? ''
        : binary(stream ?? Buffer.alloc(0))
    const failure = () => {
      if (result.error?.code === 'ENOBUFS') {
        throw new CapabilityInvocationError('resource.byte_limit', context.operation)
      }
      if (result.error?.code === 'ETIMEDOUT') {
        throw new CapabilityInvocationError('provider.timeout', context.operation)
      }
      throw new CapabilityInvocationError('provider.unavailable', context.operation)
    }
    if (context.member === 'execFileSync' || context.member === 'execSync') {
      if (result.error != null || result.status !== 0) failure()
      return output(result.stdout)
    }
    return {
      ...(result.error == null
        ? {}
        : {
          error: nodeError(
            result.error.code === 'ENOBUFS'
              ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              : result.error.code === 'ETIMEDOUT'
              ? 'ETIMEDOUT'
              : 'ERR_OPERATION_FAILED'
          )
        }),
      pid: this.#resources.allocatePublicId(),
      signal: result.signal,
      status: result.status,
      stderr: output(result.stderr),
      stdout: output(result.stdout)
    }
  }
}
