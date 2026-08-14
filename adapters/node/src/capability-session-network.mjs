const NETWORK_LIMIT_KEYS = Object.freeze([
  'maxChunkBytes',
  'maxConcurrentConnections',
  'maxHeaderBytes',
  'maxHeaders',
  'maxRequestBodyBytes',
  'maxResponseBodyBytes',
  'maxUrlBytes',
  'socketTimeoutMs'
])

const invalid = () => {
  throw new TypeError('Invalid Node capability Runtime session')
}

export const assertNodeCapabilityNetworkIntersection = (session, legacy) => {
  if (session == null) return
  const current = session.runtimeCreation.configuration.sandboxPolicy.network
  if (current.access !== legacy.access) return invalid()
  const expectedProvider = current.access === 'mockOnly' ? 'host.network.mock' : 'host.network'
  if (current.access === 'none') return
  if (session.providerConfiguration.networkProvider !== expectedProvider) return invalid()
  if (
    JSON.stringify(current.allowedOrigins) !== JSON.stringify(legacy.allowedOrigins) ||
    JSON.stringify(current.allowedSchemes) !== JSON.stringify(legacy.allowedSchemes) ||
    current.allowPrivateNetwork !== legacy.allowPrivateNetwork ||
    NETWORK_LIMIT_KEYS.some(key => current.limits[key] !== legacy.limits[key]) ||
    current.limits.maxRedirects !== 10 ||
    current.requestBodyInspection.access !== 'none'
  ) return invalid()
}
