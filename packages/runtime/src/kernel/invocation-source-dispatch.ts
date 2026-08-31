import { exactInvocationInputV1 } from './invocation-input.js'
import { normalizeCapabilityInvocationSourceV1 } from './invocation-source.js'
import type { JsonValueV1 } from './json-types.js'

const normalize = (input: unknown) => {
  const value = exactInvocationInputV1(input, [
    'arguments',
    'bindingId',
    'member',
    'mode',
    'module',
    'path',
    'providerData',
    'resourceType',
    'source'
  ])
  return Object.freeze({
    json: JSON.stringify({
      ...(value.arguments === undefined ? {} : { arguments: value.arguments }),
      ...(value.bindingId === undefined ? {} : { bindingId: value.bindingId }),
      member: value.member,
      mode: value.mode,
      module: value.module,
      ...(value.path === undefined ? {} : { path: value.path }),
      ...(value.providerData === undefined ? {} : { providerData: value.providerData }),
      ...(value.resourceType === undefined ? {} : { resourceType: value.resourceType })
    }),
    source: normalizeCapabilityInvocationSourceV1(value.source)
  })
}

export const invokeFromCapabilitySourceV1 = async (
  input: unknown,
  dispatch: (json: string, source: ReturnType<typeof normalizeCapabilityInvocationSourceV1>) => Promise<JsonValueV1>
): Promise<JsonValueV1> => {
  const value = normalize(input)
  return dispatch(value.json, value.source)
}

export const invokeFromCapabilitySourceSyncV1 = (
  input: unknown,
  dispatch: (json: string, source: ReturnType<typeof normalizeCapabilityInvocationSourceV1>) => JsonValueV1
): JsonValueV1 => {
  const value = normalize(input)
  return dispatch(value.json, value.source)
}
