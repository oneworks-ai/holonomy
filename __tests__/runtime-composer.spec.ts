import { describe, expect, it } from 'vitest'

import { RuntimeEventLoop, createMobileRuntime } from '../src/index.js'
import type { HostEventLoopPort, NativePort } from '../src/index.js'

const host = (): HostEventLoopPort => ({
  checkpointMicrotasks() {},
  now: () => 0,
  requestWakeup() {},
  terminate() {}
})

const port = (): NativePort => ({
  cancel() {},
  closeResource() {},
  dispatch() {},
  dispose() {},
  grantCredits() {}
})

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

describe('runtime composer', () => {
  it('always installs frozen Node Core, Streams and explicit globals', async () => {
    const loop = new RuntimeEventLoop(host())
    const runtime = await createMobileRuntime({
      authority: { capabilities: [], principal: 'principal' },
      eventLoop: loop,
      nativePort: port(),
      nodeCore: nodeCore()
    })
    expect(Object.isFrozen(runtime)).toBe(true)
    expect(Object.keys(runtime.syntheticModules)).toContain('node:stream/web')
    expect(Object.keys(runtime.syntheticModules)).toContain('node:buffer')
    expect(runtime.globals.ReadableStream).toBeDefined()
    expect(runtime.getSnapshot().disposed).toBe(false)
    await runtime.dispose()
    expect(runtime.getSnapshot().disposed).toBe(true)
    expect(runtime.getSnapshot().nativeBridge.pendingRequests).toBe(0)
  })

  it('fails closed for an absent opt-in capability', async () => {
    await expect(
      createMobileRuntime({
        authority: { capabilities: [], principal: 'principal' },
        eventLoop: new RuntimeEventLoop(host()),
        nativePort: port(),
        nodeCore: nodeCore(),
        fs: {}
      })
    ).rejects.toThrow('runtime_composer.required_capability')
  })
})
