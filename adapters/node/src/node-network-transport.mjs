import { NodeNetworkAuthority } from './network-authority.mjs'
import { NodeHttpNetworkHost } from './node-http-network-host.mjs'
import { NodeNetworkNativePort } from './node-network-native-port.mjs'

const networkRules = authority =>
  (authority.allowedOrigins ?? []).map(origin => ({
    allowPrivateNetwork: authority.privateNetwork === 'allow',
    origin
  }))

export const createNodeNetworkPort = (sandboxPlan, emitNetwork, dependencies = {}) => {
  if (sandboxPlan.access !== 'restricted') return undefined
  const createHost = dependencies.createHost ?? (options => new NodeHttpNetworkHost(options))
  const createPort = dependencies.createPort ?? ((host, options) => new NodeNetworkNativePort(host, options))
  const networkAuthority = sandboxPlan.authority
  const authority = new NodeNetworkAuthority(networkRules(networkAuthority))
  const networkHost = createHost({
    authority,
    limits: networkAuthority.limits,
    maxResponseBytes: networkAuthority.limits.maxResponseBodyBytes,
    observer: event => emitNetwork({ layer: 'transport', ...event })
  })
  return createPort(networkHost, { maxChunkBytes: networkAuthority.limits.maxChunkBytes })
}
