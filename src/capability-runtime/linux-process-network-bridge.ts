import { CapabilityInvocationError } from './errors.js'
import type { ProcessSandboxV2 } from './policy-process-types.js'

export interface LinuxProcessNetworkBridgeInputV1 {
  readonly environmentId: string
  readonly executableId: string
  readonly hostname: string
  readonly linuxPid: number
  readonly policy: ProcessSandboxV2
  readonly port: number
  readonly processId: number
  readonly processResourceId: string
  readonly scope: 'processTree' | 'runtime'
  readonly transport: 'tcp' | 'tls'
}

export interface LinuxProcessNetworkAuthorizationReceiptV1 {
  readonly authorized: true
  readonly generation: number
  readonly invocationBindingDigest: string
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
        processResourceId: input.processResourceId,
        syntheticProcessId: input.processId
      })
    })) as Partial<LinuxProcessNetworkAuthorizationReceiptV1>
    if (
      value?.authorized !== true || !Number.isSafeInteger(value.generation) ||
      typeof value.invocationBindingDigest !== 'string' ||
      typeof value.semanticResourceDigest !== 'string'
    ) {
      throw new CapabilityInvocationError('provider.protocol_error', 'process.network.connect')
    }
    return Object.freeze(value as LinuxProcessNetworkAuthorizationReceiptV1)
  }
}
