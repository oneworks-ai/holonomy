import { describe, expect, it } from 'vitest'

import { RuntimeEventLoop, createHolonomyRuntime } from '../../../src/index.js'
import type { HostEventLoopPort, NativePort } from '../../../src/index.js'

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
    const runtime = await createHolonomyRuntime({
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

  it('installs an admitted host facade in place of an overridable synthetic module', async () => {
    const arch = () => 'host-projected'
    const namespace = Object.freeze({ arch, default: Object.freeze({ arch }) })
    const runtime = await createHolonomyRuntime({
      authority: { capabilities: [], principal: 'principal' },
      eventLoop: new RuntimeEventLoop(host()),
      moduleOverrides: Object.freeze({
        'holo:device': Object.freeze({
          descriptor: Object.freeze({ exportNames: Object.freeze(['getFormFactor']) }),
          namespace: Object.freeze({ getFormFactor: () => 'desktop' })
        }),
        'node:os': Object.freeze({
          descriptor: Object.freeze({ exportNames: Object.freeze(['arch', 'default']) }),
          namespace
        })
      }),
      nativePort: port(),
      nodeCore: nodeCore()
    })

    expect(runtime.syntheticModules['node:os']?.namespace).toBe(namespace)
    expect(runtime.syntheticModules['holo:device']?.namespace).toMatchObject({ getFormFactor: expect.any(Function) })
    expect(runtime.syntheticModules['node:os']?.descriptor.exportNames).toEqual(['arch', 'default'])
    await runtime.dispose()
  })

  it('fails closed for an absent opt-in capability', async () => {
    await expect(
      createHolonomyRuntime({
        authority: { capabilities: [], principal: 'principal' },
        eventLoop: new RuntimeEventLoop(host()),
        nativePort: port(),
        nodeCore: nodeCore(),
        fs: {}
      })
    ).rejects.toThrow('runtime_composer.required_capability')
  })
})
