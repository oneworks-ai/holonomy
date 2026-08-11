import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { MemoryFsNativePort, RuntimeEventLoop, createFsAuthority, createHolonomyRuntime } from '../../../src/index.js'
import type { HostEventLoopPort } from '../../../src/index.js'

const host = (): HostEventLoopPort => ({ checkpointMicrotasks() {}, now: () => 0, requestWakeup() {}, terminate() {} })
const nodeCore = () => ({
  os: {
    arch: 'arm64',
    homedir: '/app/home',
    hostname: 'runtime',
    identityPolicy: 'synthetic' as const,
    platform: 'android',
    release: '1',
    tmpdir: '/app/tmp',
    type: 'Mobile',
    userInfo: { gid: 1, homedir: '/app/home', shell: null, uid: 1, username: 'runtime' }
  },
  process: {
    arch: 'arm64',
    argv: [],
    cwd: '/app',
    env: {},
    execPath: '/app/node',
    pid: 1,
    platform: 'android',
    versions: { node: '22' }
  },
  stdio: { write: () => true },
  virtualRoot: '/app'
})

describe('runtime composer V4 node:fs synthetic module', () => {
  it('preserves default export in namespace, descriptor and composed loader plan', async () => {
    const authority = createFsAuthority({
      capabilities: ['host.fs.v1'],
      principal: 'plugin',
      roots: { workspace: { permissions: ['metadata', 'read', 'write'], rootId: 'workspace' } }
    })
    const source = 'import fs from "node:fs"; export default fs;'
    const bytes = new TextEncoder().encode(source)
    const runtime = await createHolonomyRuntime({
      authority: { capabilities: ['host.fs.v1'], principal: 'plugin' },
      eventLoop: new RuntimeEventLoop(host()),
      nativePort: new MemoryFsNativePort({ authorities: [authority] }),
      nodeCore: nodeCore(),
      fs: {},
      moduleLoader: {
        readModule: url =>
          url === 'app:///bundle/entry.mjs'
            ? { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
            : null,
        rootUrl: 'app:///bundle/'
      }
    })
    const fs = runtime.syntheticModules['node:fs']!
    expect(fs.namespace).toHaveProperty('default')
    expect(fs.descriptor.exportNames).toContain('default')
    const plan = await runtime.moduleLoader!.createPlan('./entry.mjs')
    expect(plan.modules.find(item => item.url === 'node:fs')?.exportNames).toContain('default')
    await runtime.dispose()
  })
})
