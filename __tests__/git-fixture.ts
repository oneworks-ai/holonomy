import type { GitAuthorityInput } from '../src/index.js'

export const gitAuthorityInput = (): GitAuthorityInput => ({
  capabilities: ['host.git.v1', 'host.fs.v1'],
  configKeys: ['user.name', 'user.email'],
  credentials: [{
    allowedOrigins: ['https://git.example'],
    operations: ['clone', 'fetch', 'push'],
    reference: 'credential-1'
  }],
  filesystem: {
    capabilities: ['host.git.v1', 'host.fs.v1'],
    principal: 'plugin-1',
    roots: {
      workspace: {
        permissions: ['metadata', 'read', 'write'],
        rootId: 'workspace-1'
      }
    }
  },
  network: {
    allowedOrigins: ['https://git.example'],
    allowedSchemes: ['https']
  },
  operations: ['clone', 'config.read', 'fetch', 'push', 'remote.read', 'repository.open', 'status'],
  principal: 'plugin-1'
})
