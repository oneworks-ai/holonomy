import { CapabilityInvocationError } from './errors.js'

export const exactInvocationInputV1 = (
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !keys.includes(key))) {
    throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
  }
  return input
}
