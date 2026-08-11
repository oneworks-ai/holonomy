import type { NodeCoreCompatOptions } from '../../../src/node-compat/types.js'

export const createNodeCoreOptions = (
  writes: Array<{ chunk: string | Uint8Array; stream: 'stderr' | 'stdout' }> = []
): NodeCoreCompatOptions => ({
  os: {
    arch: 'arm64',
    homedir: '/app/home/runtime',
    hostname: 'holonomy',
    identityPolicy: 'synthetic',
    platform: 'android',
    release: 'virtual-1',
    tmpdir: '/app/tmp',
    type: 'HolonomyRuntime',
    userInfo: {
      gid: 1000,
      homedir: '/app/home/runtime',
      shell: null,
      uid: 1000,
      username: 'runtime'
    }
  },
  process: {
    arch: 'arm64',
    argv: ['/app/bin/node', '/app/project/plugin.mjs'],
    cwd: '/app/project',
    env: { NODE_ENV: 'production' },
    execPath: '/app/bin/node',
    pid: 41,
    platform: 'android',
    versions: { node: '22.0.0-mobile' }
  },
  stdio: {
    write(stream, chunk) {
      writes.push({ chunk, stream })
      return true
    }
  },
  virtualRoot: '/app'
})
