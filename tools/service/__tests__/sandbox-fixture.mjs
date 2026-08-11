import { compileSandboxPolicy } from '../sandbox-policy.mjs'

export const sandboxNetworkLimits = Object.freeze({
  maxChunkBytes: 65_536,
  maxConcurrentConnections: 8,
  maxHeaderBytes: 65_536,
  maxHeaders: 128,
  maxRequestBodyBytes: 1_048_576,
  maxResponseBodyBytes: 8_388_608,
  maxUrlBytes: 65_536,
  socketTimeoutMs: 30_000
})

export const restrictedSandboxPolicy = (origins = ['https://api.example'], options = {}) =>
  compileSandboxPolicy({
    filesystem: { access: 'none' },
    network: {
      access: 'restricted',
      allowedOrigins: origins,
      allowedSchemes: options.allowedSchemes ?? ['https'],
      allowPrivateNetwork: options.allowPrivateNetwork ?? false,
      limits: sandboxNetworkLimits
    },
    schemaVersion: 1
  }).policy

export const runtimeLaunch = (target, options = {}) => ({
  entryUrl: 'app+local://workspace/main.mjs',
  ...(options.env == null ? {} : { env: options.env }),
  moduleRootUrl: 'app+local://workspace/',
  modules: [{
    source: options.source ?? 'export {}',
    url: 'app+local://workspace/main.mjs'
  }],
  schemaVersion: 2,
  target
})
