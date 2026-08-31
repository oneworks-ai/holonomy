import { CapabilityInvocationError } from './errors.js'
import type { JsonValueV1 } from './json-types.js'

const invalid = (): never => {
  throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
}

const object = (value: JsonValueV1 | undefined): Readonly<Record<string, JsonValueV1>> => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Readonly<Record<string, JsonValueV1>>
}

export const bindInvocationAbortSignalV1 = (
  value: JsonValueV1 | undefined,
  bindingId: string | undefined,
  generation: number
): JsonValueV1 => {
  if (value === undefined) {
    if (bindingId != null) return invalid()
    return Object.freeze({})
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (bindingId != null) return invalid()
    return value
  }
  const argumentsValue = object(value)
  const optionsValue = argumentsValue.options
  if (optionsValue === undefined) {
    if (bindingId == null) return argumentsValue
    return Object.freeze({
      ...argumentsValue,
      options: Object.freeze({
        signal: Object.freeze({ bindingId, generation })
      })
    })
  }
  const options = object(optionsValue)
  if (Object.hasOwn(options, 'signal')) return invalid()
  if (bindingId == null) return argumentsValue
  return Object.freeze({
    ...argumentsValue,
    options: Object.freeze({
      ...options,
      signal: Object.freeze({ bindingId, generation })
    })
  })
}
