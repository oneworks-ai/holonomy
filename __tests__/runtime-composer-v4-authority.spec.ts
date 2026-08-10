import { describe, expect, it } from 'vitest'

import { RuntimeEventLoop, createMobileRuntime } from '../src/index.js'
import type { HostEventLoopPort, MobileRuntimeOptions, NativePort } from '../src/index.js'
import { gitAuthorityInput } from './git-fixture.js'

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
const compose = (authority: MobileRuntimeOptions['authority'], extras: Record<string, unknown>) =>
  createMobileRuntime(
    {
      authority,
      eventLoop: new RuntimeEventLoop(host()),
      nativePort: port(),
      nodeCore: nodeCore(),
      ...extras
    } as MobileRuntimeOptions
  )
const storage = () => ({
  capabilities: ['host.storage.v1'],
  namespace: 'application-data',
  operations: ['kv.get'],
  principal: 'plugin-1'
})

describe('runtime composer V4 authority admission', () => {
  it('composes valid exact Git and Storage authorities', async () => {
    const git = gitAuthorityInput()
    const root = { capabilities: git.capabilities, principal: git.principal }
    const gitRuntime = await compose(root, { git })
    expect(gitRuntime.git).toBeDefined()
    await gitRuntime.dispose()
    const value = storage()
    const storageRuntime = await compose({ capabilities: value.capabilities, principal: value.principal }, {
      storage: value
    })
    expect(storageRuntime.storage).toBeDefined()
    await storageRuntime.dispose()
  })
  it('rejects raw Git unknown keys without invoking their accessor', async () => {
    const git = gitAuthorityInput() as ReturnType<typeof gitAuthorityInput> & { extra?: unknown }
    let reads = 0
    Object.defineProperty(git, 'extra', {
      enumerable: true,
      get: () => {
        reads += 1
        return true
      }
    })
    await expect(compose({ capabilities: git.capabilities, principal: git.principal }, { git })).rejects.toMatchObject({
      code: 'runtime_composer.invalid_options'
    })
    expect(reads).toBe(0)
  })
  it('rejects raw Storage symbols before normalization', async () => {
    const value = storage() as typeof storage extends () => infer T ? T & { [key: symbol]: unknown } : never
    value[Symbol('extra')] = true
    await expect(compose({ capabilities: value.capabilities, principal: value.principal }, { storage: value })).rejects
      .toMatchObject({ code: 'runtime_composer.invalid_options' })
  })

  it('rejects sparse and accessor-bearing nested Git arrays without executing accessors', async () => {
    const git = gitAuthorityInput()
    const sparse = Array.from<string>({ length: 1 })
    delete sparse[0]
    ;(git as { configKeys: readonly string[] }).configKeys = sparse
    await expect(compose({ capabilities: git.capabilities, principal: git.principal }, { git })).rejects
      .toMatchObject({ code: 'runtime_composer.invalid_options' })

    const second = gitAuthorityInput()
    let reads = 0
    Object.defineProperty(second.credentials![0]!, 'operations', {
      enumerable: true,
      get: () => {
        reads += 1
        return ['clone']
      }
    })
    await expect(compose({ capabilities: second.capabilities, principal: second.principal }, { git: second }))
      .rejects.toMatchObject({ code: 'runtime_composer.invalid_options' })
    expect(reads).toBe(0)
  })

  it('rejects hostile nested Git records and sparse Storage operations stably', async () => {
    const git = gitAuthorityInput()
    git.filesystem.roots = new Proxy(git.filesystem.roots, {
      getPrototypeOf: () => {
        throw new Error('nested secret')
      }
    })
    await expect(compose({ capabilities: git.capabilities, principal: git.principal }, { git })).rejects
      .toMatchObject({ code: 'runtime_composer.invalid_options', message: 'runtime_composer.invalid_options' })

    const value = storage()
    const sparse = Array.from<string>({ length: 1 })
    delete sparse[0]
    ;(value as { operations: readonly string[] }).operations = sparse
    await expect(compose({ capabilities: value.capabilities, principal: value.principal }, { storage: value }))
      .rejects.toMatchObject({ code: 'runtime_composer.invalid_options' })
  })
})
