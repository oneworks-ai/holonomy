import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel/errors'
import { utf8ByteLength } from '@holonomyjs/runtime/node-compat/utf8'
import type { ProcessSandboxV2 } from './policy-process-types.js'

export interface LinuxProcessExecutionBridgeInputV1 {
  readonly argv: readonly string[]
  readonly callerExecutableId: string
  readonly cwd: string
  readonly environmentId: string
  readonly executableId: string
  readonly linuxPid: number
  readonly parentLinuxPid: number
  readonly path: string
  readonly policy: ProcessSandboxV2
  readonly processId: number
  readonly processResourceId: string
  readonly processStartTimeTicks: number
  readonly rootLinuxPid: number
  readonly scope: 'processTree' | 'runtime'
}

export interface LinuxProcessExecutionAuthorizationReceiptV1 {
  readonly authorized: true
  readonly generation: number
  readonly invocationBindingDigest: string
  readonly semanticResourceDigest: string
}

export class LinuxProcessExecutionCapabilityBridgeV1 {
  #invoke?: (input: Readonly<Record<string, unknown>>) => Promise<unknown>

  bind(invoke: (input: Readonly<Record<string, unknown>>) => Promise<unknown>): this {
    if (this.#invoke != null || typeof invoke !== 'function') {
      throw new TypeError('Invalid Linux process execution binding')
    }
    this.#invoke = invoke
    return this
  }

  async authorize(
    input: LinuxProcessExecutionBridgeInputV1
  ): Promise<LinuxProcessExecutionAuthorizationReceiptV1> {
    if (this.#invoke == null) {
      throw new CapabilityInvocationError('provider.unavailable', 'process.program.spawn')
    }
    const policy = input.policy
    if (policy.access !== 'sandboxed') {
      throw new CapabilityInvocationError('policy.denied', 'process.program.spawn')
    }
    const executable = policy.executables.find(candidate => candidate.executableId === input.executableId)
    const argumentBytes = input.argv.slice(1).reduce((sum, value) => sum + utf8ByteLength(value), 0)
    if (executable == null || argumentBytes > executable.argumentBytes) {
      throw new CapabilityInvocationError('policy.denied', 'process.program.spawn')
    }
    const value = await this.#invoke(Object.freeze({
      arguments: Object.freeze({
        argv: Object.freeze([...input.argv]),
        cwd: input.cwd,
        environmentId: input.environmentId,
        environmentScope: input.scope,
        executableId: input.executableId,
        linuxPid: input.linuxPid,
        parentLinuxPid: input.parentLinuxPid,
        path: input.path,
        processStartTimeTicks: input.processStartTimeTicks
      }),
      member: 'authorizeDescendantProcess',
      mode: 'promise',
      module: 'holo:runtime',
      source: Object.freeze({
        environmentId: input.environmentId,
        environmentScope: input.scope,
        executableId: input.callerExecutableId,
        kind: 'linuxProcess',
        linuxPid: input.linuxPid,
        parentLinuxPid: input.parentLinuxPid,
        processStartTimeTicks: input.processStartTimeTicks,
        processResourceId: input.processResourceId,
        rootLinuxPid: input.rootLinuxPid,
        syntheticProcessId: input.processId
      })
    })) as Partial<LinuxProcessExecutionAuthorizationReceiptV1>
    if (
      value?.authorized !== true || !Number.isSafeInteger(value.generation) ||
      typeof value.invocationBindingDigest !== 'string' ||
      typeof value.semanticResourceDigest !== 'string'
    ) {
      throw new CapabilityInvocationError('provider.protocol_error', 'process.program.spawn')
    }
    return Object.freeze(value as LinuxProcessExecutionAuthorizationReceiptV1)
  }
}
