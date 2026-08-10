import { describe, expect, it } from 'vitest'

import { RuntimeEventLoop, createHolonomyRuntime } from '../src/index.js'
import type { HostEventLoopPort, NativeCallToken, NativePort } from '../src/index.js'
import { setRuntimeComposerFactoriesForTest } from '../src/runtime/factories.js'
import type { RuntimeComposerFactories } from '../src/runtime/factories.js'

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

describe('runtime composer V4 pending bridge disposal', () => {
  it('awaits strict reverse rollback, preserves the selected error and swallows cleanup failures', async () => {
    const order: string[] = []
    const counts = new Map<string, number>()
    let releaseNetwork!: () => void
    const networkGate = new Promise<void>(resolve => {
      releaseNetwork = resolve
    })
    const owner = (name: string, wait?: Promise<void>, fail = false) => ({
      dispose: async () => {
        counts.set(name, (counts.get(name) ?? 0) + 1)
        order.push(name)
        await wait
        if (fail) throw new Error('cleanup secret')
      }
    })
    const restore = setRuntimeComposerFactoriesForTest({
      createFetchRuntime: () => owner('network', networkGate) as never,
      createHttpServerRuntime: () => owner('http') as never,
      createNativeBridge: () => owner('bridge') as never,
      createNodeFsFacade: () => owner('fs') as never,
      installCryptoRuntime: () => owner('crypto', undefined, true) as never
    } as RuntimeComposerFactories)
    let settled = false
    let unhandled = 0
    const onUnhandled = () => {
      unhandled += 1
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const creation = createHolonomyRuntime({
        authority: {
          capabilities: ['host.fs.v1', 'http.server', 'host.network.http', 'host.git.v1'],
          principal: 'principal'
        },
        crypto: {} as never,
        eventLoop: new RuntimeEventLoop(host()),
        fs: {},
        git: {} as never,
        httpServer: {},
        nativePort: {} as NativePort,
        network: { authority: { allowedOrigins: ['https://example.test'] }, principal: 'principal' },
        nodeCore: nodeCore()
      })
      void creation.finally(() => {
        settled = true
      }).catch(() => {})
      await Promise.resolve()
      expect(order).toEqual(['network'])
      expect(settled).toBe(false)
      releaseNetwork()
      await expect(creation).rejects.toMatchObject({
        code: 'runtime_composer.invalid_options',
        message: 'runtime_composer.invalid_options'
      })
      expect(order).toEqual(['network', 'crypto', 'http', 'fs', 'bridge'])
      expect([...counts.values()]).toEqual([1, 1, 1, 1, 1])
      await Promise.resolve()
      expect(unhandled).toBe(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
      restore()
    }
  })

  it('cancels a pending native request once, zeros counters and leaves caller loop usable', async () => {
    let cancels = 0
    let disposes = 0
    const nativePort: NativePort = {
      cancel(_token: NativeCallToken) {
        cancels += 1
      },
      closeResource() {},
      dispatch() {},
      dispose() {
        disposes += 1
      },
      grantCredits() {}
    }
    const loop = new RuntimeEventLoop(host())
    const runtime = await createHolonomyRuntime({
      authority: { capabilities: [], principal: 'principal' },
      eventLoop: loop,
      nativePort,
      nodeCore: nodeCore()
    })
    const pending = runtime.bridge.request({ args: {}, id: 'pending', module: 'host.test', operation: 'pending' })
    const first = runtime.dispose()
    expect(runtime.dispose()).toBe(first)
    await first
    await expect(pending).rejects.toMatchObject({ code: 'disposed' })
    expect(cancels).toBe(1)
    expect(disposes).toBe(1)
    expect(runtime.getSnapshot().nativeBridge).toMatchObject({
      inFlightBinaryBytes: 0,
      inFlightBinaryHandles: 0,
      openHandles: 0,
      openResources: 0,
      outstandingCredits: 0,
      pendingRequests: 0
    })
    expect(() => loop.enqueueMacrotask(() => {})).not.toThrow()
  })
})
