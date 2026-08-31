import type { ProcessSandboxV2 } from '@holonomyjs/capability-process/kernel/policy-process-types'
import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel/errors'

export interface LinuxProcessNetworkBridgeInputV1 {
  readonly environmentId: string
  readonly executableId: string
  readonly hostname: string
  readonly linuxPid: number
  readonly parentLinuxPid?: number
  readonly policy: ProcessSandboxV2
  readonly port: number
  readonly processId: number
  readonly processResourceId: string
  readonly processStartTimeTicks?: number
  readonly rootLinuxPid?: number
  readonly scope: 'processTree' | 'runtime'
  readonly transport: 'tcp' | 'tls' | 'udp'
}

export interface LinuxProcessNetworkAuthorizationReceiptV1 {
  readonly authorized: true
  readonly generation: number
  readonly invocationBindingDigest: string
  readonly resolution: {
    readonly addresses: readonly string[]
    readonly evidenceDigest: string
    readonly expiresAtMonotonicMs: number
    readonly resolverGeneration: number
  }
  readonly semanticResourceDigest: string
}

type KernelInvokeV1 = (input: Readonly<Record<string, unknown>>) => Promise<unknown>

export class LinuxProcessNetworkCapabilityBridgeV1 {
  #invoke?: KernelInvokeV1

  bind(invoke: KernelInvokeV1): this {
    if (this.#invoke != null || typeof invoke !== 'function') {
      throw new TypeError('Invalid Linux process network binding')
    }
    this.#invoke = invoke
    return this
  }

  async authorize(
    input: LinuxProcessNetworkBridgeInputV1
  ): Promise<LinuxProcessNetworkAuthorizationReceiptV1> {
    if (this.#invoke == null) {
      throw new CapabilityInvocationError('provider.unavailable', 'process.network.connect')
    }
    const policy = input.policy
    if (policy.access !== 'sandboxed' || policy.network.access !== 'restricted') {
      throw new CapabilityInvocationError('policy.denied', 'process.network.connect')
    }
    const endpoint = policy.network.endpoints.find(candidate =>
      candidate.hostname === input.hostname.toLowerCase() &&
      candidate.transport === input.transport && candidate.ports.includes(input.port)
    )
    if (endpoint == null) {
      throw new CapabilityInvocationError('policy.denied', 'process.network.connect')
    }
    const value = await this.#invoke(Object.freeze({
      arguments: Object.freeze({
        hostname: endpoint.hostname,
        port: input.port,
        transport: endpoint.transport
      }),
      member: 'authorizeProcessNetwork',
      mode: 'promise',
      module: 'holo:runtime',
      source: Object.freeze({
        environmentId: input.environmentId,
        environmentScope: input.scope,
        executableId: input.executableId,
        kind: 'linuxProcess',
        linuxPid: input.linuxPid,
        ...(input.parentLinuxPid == null ? {} : { parentLinuxPid: input.parentLinuxPid }),
        processResourceId: input.processResourceId,
        ...(input.processStartTimeTicks == null
          ? {}
          : { processStartTimeTicks: input.processStartTimeTicks }),
        ...(input.rootLinuxPid == null ? {} : { rootLinuxPid: input.rootLinuxPid }),
        syntheticProcessId: input.processId
      })
    })) as Partial<LinuxProcessNetworkAuthorizationReceiptV1>
    if (
      value?.authorized !== true || !Number.isSafeInteger(value.generation) ||
      typeof value.invocationBindingDigest !== 'string' ||
      value.resolution == null || !Array.isArray(value.resolution.addresses) ||
      value.resolution.addresses.length < 1 || value.resolution.addresses.length > 64 ||
      value.resolution.addresses.some(address => typeof address !== 'string') ||
      [...value.resolution.addresses].sort().some((address, index) =>
        address !== value.resolution!.addresses[index] ||
        index > 0 && address === value.resolution!.addresses[index - 1]
      ) ||
      typeof value.resolution.evidenceDigest !== 'string' ||
      !/^[\da-f]{64}$/u.test(value.resolution.evidenceDigest) ||
      !Number.isFinite(value.resolution.expiresAtMonotonicMs) ||
      value.resolution.expiresAtMonotonicMs < 0 ||
      value.resolution.expiresAtMonotonicMs > Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(value.resolution.resolverGeneration) ||
      value.resolution.resolverGeneration < 0 ||
      typeof value.semanticResourceDigest !== 'string'
    ) {
      throw new CapabilityInvocationError('provider.protocol_error', 'process.network.connect')
    }
    return Object.freeze(value as LinuxProcessNetworkAuthorizationReceiptV1)
  }
}
