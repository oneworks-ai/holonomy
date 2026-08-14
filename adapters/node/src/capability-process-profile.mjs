import { NODE_PROCESS_BACKEND_REGISTRY_V1 } from './capability-process-backend.mjs'

const invalid = () => {
  throw new TypeError('Invalid Node capability Runtime session')
}
const exact = (value, keys) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid()
  return value
}
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][\w.-]{0,127}$/u.test(value) ? value : invalid()

const normalizeProcessEnvironment = (value, backendScopes) => {
  const input = exact(value, ['allowedScopes', 'defaultScope'])
  if (
    !Array.isArray(input.allowedScopes) || input.allowedScopes.length === 0 ||
    input.allowedScopes.some(scope => !['processTree', 'runtime'].includes(scope)) ||
    new Set(input.allowedScopes).size !== input.allowedScopes.length ||
    input.allowedScopes.some(scope => !backendScopes.includes(scope)) ||
    !input.allowedScopes.includes(input.defaultScope)
  ) return invalid()
  const allowedScopes = [...input.allowedScopes].sort()
  return Object.freeze({ allowedScopes: Object.freeze(allowedScopes), defaultScope: input.defaultScope })
}

export const normalizeNodeProcessProfileV1 = (
  value,
  registry = NODE_PROCESS_BACKEND_REGISTRY_V1,
  platform = 'node'
) => {
  if (!['desktop', 'node'].includes(platform)) return invalid()
  const input = exact(value, ['backend', 'defaultShellExecutableId', 'environment', 'executables', 'profile'])
  if (input.profile !== 'process-profile-v1' || !Array.isArray(input.executables) || input.executables.length > 256) {
    return invalid()
  }
  const backend = registry.normalizeProfileBackend(input.backend)
  const descriptor = registry.get(backend.backendId)?.descriptor
  if (descriptor == null || !descriptor.platforms.includes(platform)) return invalid()
  const executables = input.executables.map(value => {
    const item = exact(value, ['executable', 'executableId', 'executablePath', 'fixedArgs', 'shell'])
    if ((item.executable == null) === (item.executablePath == null)) return invalid()
    const executableInput = item.executable ?? { kind: 'hostPath', path: item.executablePath }
    const executable = registry.normalizeExecutable(backend.backendId, executableInput)
    if (
      !Array.isArray(item.fixedArgs) || item.fixedArgs.length > 64 ||
      item.fixedArgs.some(arg => typeof arg !== 'string')
    ) {
      return invalid()
    }
    if (item.shell != null && typeof item.shell !== 'boolean') return invalid()
    if (item.shell === true && descriptor.features.shell !== true) return invalid()
    return Object.freeze({
      executable,
      executableId: identifier(item.executableId),
      fixedArgs: Object.freeze([...item.fixedArgs]),
      shell: item.shell === true
    })
  }).sort((left, right) => left.executableId < right.executableId ? -1 : 1)
  if (new Set(executables.map(item => item.executableId)).size !== executables.length) return invalid()
  const defaultShellExecutableId = input.defaultShellExecutableId == null
    ? undefined
    : identifier(input.defaultShellExecutableId)
  if (
    defaultShellExecutableId != null &&
    (
      descriptor.features.shell !== true ||
      !executables.some(item => item.executableId === defaultShellExecutableId && item.shell)
    )
  ) return invalid()
  const environment = normalizeProcessEnvironment(input.environment, descriptor.environmentScopes)
  const normalized = Object.freeze({
    backend,
    ...(defaultShellExecutableId == null ? {} : { defaultShellExecutableId }),
    environment,
    executables: Object.freeze(executables),
    profile: 'process-profile-v1'
  })
  registry.get(backend.backendId)?.validateProfile(normalized)
  return normalized
}
