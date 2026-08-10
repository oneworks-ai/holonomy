import { describe, expect, it } from 'vitest'

import { RuntimeEventLoop, createHolonomyRuntime } from '../src/index.js'
import type { HolonomyRuntimeOptions, HostEventLoopPort, NativePort } from '../src/index.js'

const host = (): HostEventLoopPort => ({ checkpointMicrotasks() {}, now: () => 0, requestWakeup() {}, terminate() {} })
const port = (): NativePort => ({ cancel() {}, closeResource() {}, dispatch() {}, dispose() {}, grantCredits() {} })
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
const options = (capabilities: readonly string[] = []): HolonomyRuntimeOptions => ({
  authority: { capabilities, principal: 'principal' },
  eventLoop: new RuntimeEventLoop(host()),
  nativePort: port(),
  nodeCore: nodeCore()
})
const invalid = 'runtime_composer.invalid_options'

describe('runtime composer V4 contracts', () => {
  it('rejects an unknown top-level option', async () => {
    const input = options() as HolonomyRuntimeOptions & { extra: boolean }
    input.extra = true
    await expect(createHolonomyRuntime(input)).rejects.toMatchObject({ code: invalid })
  })
  it('rejects a top-level symbol', async () => {
    const input = options() as HolonomyRuntimeOptions & { [key: symbol]: boolean }
    input[Symbol('x')] = true
    await expect(createHolonomyRuntime(input)).rejects.toMatchObject({ code: invalid })
  })
  it('redacts a top-level proxy trap', async () => {
    await expect(createHolonomyRuntime(
      new Proxy(options(), {
        getPrototypeOf: () => {
          throw new Error('secret')
        }
      })
    )).rejects.toMatchObject({ code: invalid })
  })
  it('accepts the actual HTTP server capability', async () => {
    const input = options(['http.server']) as HolonomyRuntimeOptions & { httpServer: {} }
    input.httpServer = {}
    const runtime = await createHolonomyRuntime(input)
    expect(runtime.httpServer).toBeDefined()
    await runtime.dispose()
  })
  it('rejects the obsolete HTTP capability', async () => {
    const input = options(['host.http-server.v1']) as HolonomyRuntimeOptions & { httpServer: {} }
    input.httpServer = {}
    await expect(createHolonomyRuntime(input)).rejects.toMatchObject({ code: 'runtime_composer.required_capability' })
  })
  it('rejects a mismatched Network principal', async () => {
    const input = options(['host.network.http']) as HolonomyRuntimeOptions & { network: unknown }
    input.network = { authority: { allowedOrigins: ['https://example.test'] }, principal: 'other' }
    await expect(createHolonomyRuntime(input)).rejects.toMatchObject({ code: 'runtime_composer.principal_mismatch' })
  })
  it('does not mutate ambient globals for an optional network runtime', async () => {
    const before = globalThis.fetch
    const input = options(['host.network.http']) as HolonomyRuntimeOptions & { network: unknown }
    input.network = { authority: { allowedOrigins: ['https://example.test'] }, principal: 'principal' }
    const runtime = await createHolonomyRuntime(input)
    expect(globalThis.fetch).toBe(before)
    await runtime.dispose()
  })
  it('keeps caller event loop alive across concurrent disposal', async () => {
    const loop = new RuntimeEventLoop(host())
    const runtime = await createHolonomyRuntime({ ...options(), eventLoop: loop })
    const first = runtime.dispose()
    expect(runtime.dispose()).toBe(first)
    await first
    expect(() => loop.enqueueMacrotask(() => {})).not.toThrow()
  })
  it('gates all loader operations while immutable inspection survives disposal', async () => {
    const input = options() as HolonomyRuntimeOptions & { moduleLoader: unknown }
    input.moduleLoader = { readModule: () => null, rootUrl: 'app:///bundle/' }
    const runtime = await createHolonomyRuntime(input)
    const loader = runtime.moduleLoader!
    const root = loader.rootUrl
    const limits = loader.limits
    await runtime.dispose()
    expect(loader.rootUrl).toBe(root)
    expect(loader.limits).toBe(limits)
    expect(() => loader.createRequire('app:///bundle/a.cjs')).toThrow('runtime_composer.disposed')
    expect(() => loader.resolveResource('./a.js', 'app:///bundle/a.js')).toThrow('runtime_composer.disposed')
    expect(() => loader.resolve('node:path')).toThrow('runtime_composer.disposed')
    expect(() => loader.load('app:///bundle/a.js')).toThrow('runtime_composer.disposed')
    expect(() => loader.createPlan('node:path')).toThrow('runtime_composer.disposed')
  })
})
