import type {
  HostBindingReferenceV1,
  ProviderBindingRegistrationV1,
  RuntimeCreationHostBindingsV1
} from './context-types.js'
import { invalidPolicy } from './errors.js'
import { array, deepFreeze, exact, identifier, required, string } from './validation.js'

const reference = (value: unknown): HostBindingReferenceV1 => {
  const input = exact(value, ['bindingId', 'ownerId', 'version'])
  return Object.freeze({
    bindingId: identifier(required(input, 'bindingId')),
    ownerId: identifier(required(input, 'ownerId')),
    version: string(required(input, 'version'), 64)
  })
}

const moduleIdentifier = (value: unknown): string => {
  const result = string(value, 128)
  if (!/^\w[\w.:/-]*$/u.test(result)) return invalidPolicy()
  return result
}

const provider = (value: unknown): ProviderBindingRegistrationV1 => {
  const input = exact(value, ['module', 'ownerId', 'providerId', 'providerVersion'])
  return Object.freeze({
    module: moduleIdentifier(required(input, 'module')),
    ownerId: identifier(required(input, 'ownerId')),
    providerId: identifier(required(input, 'providerId')),
    providerVersion: string(required(input, 'providerVersion'), 64)
  })
}

export const compileRuntimeCreationHostBindingsV1 = (
  value: unknown
): RuntimeCreationHostBindingsV1 => {
  const input = exact(value, [
    'engineGate',
    'initialMiddlewareSet',
    'initialObservers',
    'moduleResolver',
    'providerBindings'
  ])
  const output = {
    engineGate: reference(required(input, 'engineGate')),
    initialMiddlewareSet: reference(required(input, 'initialMiddlewareSet')),
    initialObservers: array(required(input, 'initialObservers'), 0, 64).map(reference),
    moduleResolver: reference(required(input, 'moduleResolver')),
    providerBindings: array(required(input, 'providerBindings'), 0, 64).map(provider)
  }
  const ids = [
    output.engineGate.bindingId,
    output.initialMiddlewareSet.bindingId,
    output.moduleResolver.bindingId,
    ...output.initialObservers.map(item => item.bindingId),
    ...output.providerBindings.map(item => item.providerId)
  ]
  if (new Set(ids).size !== ids.length) return invalidPolicy()
  output.initialObservers.sort((left, right) => left.bindingId.localeCompare(right.bindingId))
  output.providerBindings.sort((left, right) => left.module.localeCompare(right.module))
  if (new Set(output.providerBindings.map(item => item.module)).size !== output.providerBindings.length) {
    return invalidPolicy()
  }
  return deepFreeze(output)
}
