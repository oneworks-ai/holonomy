import { CapabilityInvocationError } from './errors.js'

export interface LinuxProcessInvocationSourceV1 {
  readonly environmentId: string
  readonly environmentScope: 'processTree' | 'runtime'
  readonly executableId: string
  readonly kind: 'linuxProcess'
  readonly linuxPid: number
  readonly parentLinuxPid?: number
  readonly processResourceId: string
  readonly syntheticProcessId: number
}

export type CapabilityInvocationSourceV1 = LinuxProcessInvocationSourceV1

const text = (value: unknown, maximum: number): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
  }
  return value
}

const unsigned = (value: unknown): number => {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 0xFFFFFFFF) {
    throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
  }
  return value as number
}

export const normalizeCapabilityInvocationSourceV1 = (value: unknown): CapabilityInvocationSourceV1 => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
  }
  const input = value as Record<string, unknown>
  const keys = [
    'environmentId',
    'environmentScope',
    'executableId',
    'kind',
    'linuxPid',
    'parentLinuxPid',
    'processResourceId',
    'syntheticProcessId'
  ]
  if (
    Object.keys(input).some(key => !keys.includes(key)) ||
    Object.keys(input).length !== keys.length && Object.keys(input).length !== keys.length - 1
  ) {
    throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
  }
  if (
    input.kind !== 'linuxProcess' ||
    input.environmentScope !== 'processTree' && input.environmentScope !== 'runtime'
  ) throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
  return Object.freeze({
    environmentId: text(input.environmentId, 256),
    environmentScope: input.environmentScope,
    executableId: text(input.executableId, 128),
    kind: 'linuxProcess',
    linuxPid: unsigned(input.linuxPid),
    ...(input.parentLinuxPid == null ? {} : { parentLinuxPid: unsigned(input.parentLinuxPid) }),
    processResourceId: text(input.processResourceId, 256),
    syntheticProcessId: unsigned(input.syntheticProcessId)
  })
}
