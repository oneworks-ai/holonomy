/* eslint-disable no-extend-native -- adversarial prototype poisoning is the contract under test. */
import { describe, expect, it, vi } from 'vitest'
import * as ChildProcessPublic from '../src/child-process/index.js'
import * as RootPublic from '../src/index.js'
import {
  RuntimeEventLoop,
  createGitAuthority,
  createGitFacade,
  createNativeBridge,
  gitSuccess,
  nativeAuthorityForGit
} from '../src/index.js'
import { gitAuthorityInput } from './git-fixture.js'
import { ControlledNativePort, VirtualNativeHost, providerToken } from './native-port-fixture.js'

import type { GitFacade, GitRepository } from '../src/git/types.js'

const gitError = (code: string) => Object.assign(new Error('provider secret https://private.example'), { code })

const createGit = (remotes = [{ authorized: true, fetchUrl: 'https://git.example/team/app.git', name: 'origin' }]) => {
  const close = vi.fn(() => true)
  const repository = { close, listRemotes: vi.fn(async () => remotes) } as unknown as GitRepository
  return {
    facade: { clone: vi.fn(async () => repository), open: vi.fn(async () => repository) } as unknown as GitFacade,
    repository,
    close
  }
}

const invoke = (execFile: (...arguments_: any[]) => void, ...arguments_: any[]) =>
  new Promise<{ error: Error | null; stderr: string; stdout: string }>(resolve => {
    execFile(...arguments_, (error: Error | null, stdout: string, stderr: string) => resolve({ error, stderr, stdout }))
  })

describe('restricted child_process v1', () => {
  it('maps the Relay remote query exactly, omits unauthorized URLs, and closes once', async () => {
    const git = createGit([
      { authorized: true, fetchUrl: 'https://git.example/team/app.git', name: 'origin' },
      { authorized: false, fetchUrl: 'https://secret.example/private.git', name: 'secret' }
    ])
    const child = ChildProcessPublic.createChildProcessSyntheticModule({ git: git.facade })
    const result = await invoke(child.execFile, 'git', [
      '-C',
      'mobile-fs://workspace/app',
      'config',
      '--get-regexp',
      '^remote\\..*\\.url$'
    ], { encoding: 'utf8', maxBuffer: 256 * 1024 })

    expect(result).toEqual({ error: null, stderr: '', stdout: 'remote.origin.url https://git.example/team/app.git\n' })
    expect(git.facade.open).toHaveBeenCalledWith('mobile-fs://workspace/app', {})
    expect(git.repository.listRemotes).toHaveBeenCalledWith({})
    expect(git.close).toHaveBeenCalledTimes(1)
  })

  it('maps depth-one clone with optional branch and closes its repository once', async () => {
    const git = createGit()
    const child = ChildProcessPublic.createChildProcessSyntheticModule({ git: git.facade })
    const result = await invoke(child.execFile, 'git', [
      'clone',
      '--depth',
      '1',
      '--branch',
      'main',
      'https://git.example/team/app.git',
      'mobile-fs://workspace/app'
    ], {})

    expect(result).toEqual({ error: null, stderr: '', stdout: '' })
    expect(git.facade.clone).toHaveBeenCalledWith({
      branch: 'main',
      depth: 1,
      destination: 'mobile-fs://workspace/app',
      url: 'https://git.example/team/app.git'
    }, {})
    expect(git.close).toHaveBeenCalledTimes(1)
  })

  it('is async and calls back once when a Git completion is late or fails', async () => {
    let reject!: (error: Error) => void
    const close = vi.fn(() => true)
    const facade = {
      open: vi.fn(() =>
        new Promise<GitRepository>((_resolve, reject_) => {
          reject = reject_
        })
      ),
      clone: vi.fn()
    } as unknown as GitFacade
    const child = ChildProcessPublic.createChildProcessSyntheticModule({ git: facade })
    let synchronous = true
    const callback = vi.fn()
    child.execFile(
      'git',
      ['-C', 'mobile-fs://workspace/app', 'config', '--get-regexp', '^remote\\..*\\.url$'],
      {},
      callback
    )
    expect(callback).not.toHaveBeenCalled()
    synchronous = false
    reject(gitError('git.cancelled'))
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
    expect(synchronous).toBe(false)
    expect(callback.mock.calls[0]?.[0]).toMatchObject({ code: 'child_process.cancelled' })
    expect(close).not.toHaveBeenCalled()
  })

  it('rejects shell/process escape hatches, aliases, unsupported flags and hostile input with stable errors', async () => {
    const git = createGit()
    const child = ChildProcessPublic.createChildProcessSyntheticModule({ git: git.facade })
    for (
      const [file, args] of [
        ['git; id', []],
        ['/usr/bin/git', []],
        ['git', ['clone', '--depth', '2', 'https://git.example/a', 'mobile-fs://workspace/a']],
        ['git', ['checkout', 'main']],
        ['git', ['-C', 'mobile-fs://workspace/a', 'config', '--get-regexp', '^remote\\..*\\.url$', '--global']]
      ]
    ) {
      const result = await invoke(child.execFile, file, args, {})
      expect(result.error).toMatchObject({ code: expect.stringMatching(/^child_process\./u) })
      expect(result.error?.message).not.toContain('secret')
    }
    const accessor = Object.create(null, {
      encoding: {
        enumerable: true,
        get: () => {
          throw new Error('secret')
        }
      }
    })
    const proxy = new Proxy([], {
      getPrototypeOf: () => {
        throw new Error('secret')
      }
    })
    expect((await invoke(child.execFile, 'git', proxy, {})).error).toMatchObject({
      code: 'child_process.invalid_argument'
    })
    expect((await invoke(child.execFile, 'git', [], accessor)).error).toMatchObject({
      code: 'child_process.invalid_argument'
    })
    expect(Object.keys(child)).toEqual(['execFile', 'default'])
    expect(Object.isFrozen(child)).toBe(true)
  })

  it('enforces argv/stdout bounds and forwards admitted signal/timeout options', async () => {
    const git = createGit()
    const child = ChildProcessPublic.createChildProcessSyntheticModule({
      git: git.facade,
      limits: { maxArgBytes: 4, maxStdoutBytes: 10 }
    })
    expect(
      (await invoke(child.execFile, 'git', [
        'clone',
        '--depth',
        '1',
        'https://git.example/a',
        'mobile-fs://workspace/a'
      ], {})).error
    ).toMatchObject({ code: 'child_process.limit_exceeded' })
    const bounded = ChildProcessPublic.createChildProcessSyntheticModule({
      git: git.facade,
      limits: { maxStdoutBytes: 10 }
    })
    expect(
      (await invoke(bounded.execFile, 'git', [
        '-C',
        'mobile-fs://workspace/app',
        'config',
        '--get-regexp',
        '^remote\\..*\\.url$'
      ], {})).error
    ).toMatchObject({ code: 'child_process.limit_exceeded' })
    const signal = new AbortController().signal
    const accepted = ChildProcessPublic.createChildProcessSyntheticModule({ git: git.facade })
    await invoke(accepted.execFile, 'git', [
      'clone',
      '--depth',
      '1',
      'https://git.example/a',
      'mobile-fs://workspace/a'
    ], { signal, timeout: 123 })
    expect(git.facade.clone).toHaveBeenLastCalledWith(expect.any(Object), { signal, timeoutMs: 123 })
  })

  it('exports the frozen synthetic namespace and capability contract from root and subpath', () => {
    expect(RootPublic.createChildProcessSyntheticModule).toBe(ChildProcessPublic.createChildProcessSyntheticModule)
    expect(ChildProcessPublic.CHILD_PROCESS_CAPABILITY_MATRIX).toMatchObject({
      module: 'node:child_process',
      unsupported: { shell: { status: 'unsupported' }, spawn: { status: 'unsupported' } }
    })
    const binding = ChildProcessPublic.createChildProcessSyntheticModuleBinding({ git: createGit().facade })
    expect(binding.descriptor.exportNames).toEqual(['execFile', 'default'])
  })

  it('redacts hostile provider errors and remote output injection', async () => {
    const git = createGit([{ authorized: true, fetchUrl: 'https://git.example/a\nsecret', name: 'origin' }])
    const child = ChildProcessPublic.createChildProcessSyntheticModule({ git: git.facade })
    const remote = await invoke(child.execFile, 'git', [
      '-C',
      'mobile-fs://workspace/a',
      'config',
      '--get-regexp',
      '^remote\\..*\\.url$'
    ], {})
    expect(remote.error).toMatchObject({ code: 'child_process.internal' })
    expect(remote.error?.message).not.toContain('secret')
    const hostile = new Proxy(new Error('https://secret.example'), {
      getOwnPropertyDescriptor: () => {
        throw new Error('secret')
      }
    })
    const failing = {
      open: vi.fn(async () => {
        throw hostile
      }),
      clone: vi.fn()
    } as unknown as GitFacade
    const result = await invoke(
      ChildProcessPublic.createChildProcessSyntheticModule({ git: failing }).execFile,
      'git',
      ['-C', 'mobile-fs://workspace/a', 'config', '--get-regexp', '^remote\\..*\\.url$'],
      {}
    )
    expect(result.error).toMatchObject({ code: 'child_process.internal' })
  })

  it('lets local abort win over a deferred open and closes a late repository once', async () => {
    let resolve!: (repository: GitRepository) => void
    const close = vi.fn(() => true)
    const repository = { close, listRemotes: vi.fn() } as unknown as GitRepository
    const facade = {
      open: vi.fn(() =>
        new Promise<GitRepository>(resolve_ => {
          resolve = resolve_
        })
      ),
      clone: vi.fn()
    } as unknown as GitFacade
    const controller = new AbortController()
    const signal = controller.signal
    const child = ChildProcessPublic.createChildProcessSyntheticModule({ git: facade })
    const callback = vi.fn()
    child.execFile('git', ['-C', 'mobile-fs://workspace/a', 'config', '--get-regexp', '^remote\\..*\\.url$'], {
      signal
    }, callback)
    controller.abort()
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
    resolve(repository)
    await Promise.resolve()
    expect(callback.mock.calls[0]?.[0]).toMatchObject({ code: 'child_process.cancelled' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('accepts genuine AbortSignal instances and rejects forged signals', async () => {
    const git = createGit()
    const controller = new AbortController()
    controller.abort()
    const child = ChildProcessPublic.createChildProcessSyntheticModule({ git: git.facade })
    const aborted = await invoke(child.execFile, 'git', [
      'clone',
      '--depth',
      '1',
      'https://git.example/a',
      'mobile-fs://workspace/a'
    ], { signal: controller.signal })
    expect(aborted.error).toMatchObject({ code: 'child_process.cancelled' })
    expect(git.facade.clone).not.toHaveBeenCalled()
    const forged = await invoke(child.execFile, 'git', [
      'clone',
      '--depth',
      '1',
      'https://git.example/a',
      'mobile-fs://workspace/a'
    ], { signal: {} as AbortSignal })
    expect(forged.error).toMatchObject({ code: 'child_process.internal' })
  })

  it('integrates with class-based public GitFacade and repository controllers', async () => {
    const host = new VirtualNativeHost()
    const loop = new RuntimeEventLoop(host)
    const port = new ControlledNativePort()
    const facade = createGitFacade({
      authority: gitAuthorityInput(),
      bridge: createNativeBridge(port, {
        authority: nativeAuthorityForGit(createGitAuthority(gitAuthorityInput())),
        eventLoop: loop
      })
    })
    const child = ChildProcessPublic.createChildProcessSyntheticModule({ git: facade })
    const result = invoke(child.execFile, 'git', [
      '-C',
      'mobile-fs://workspace/project',
      'config',
      '--get-regexp',
      '^remote\\..*\\.url$'
    ], {})
    const open = port.calls[0]!
    open.sink({
      id: open.request.id,
      resources: [{ providerToken: providerToken('repo-child'), type: 'git.repository' }],
      type: 'result',
      value: gitSuccess({ repository: true })
    })
    loop.runTurn()
    await vi.waitFor(() => expect(port.calls).toHaveLength(2))
    const remotes = port.calls[1]!
    remotes.sink({
      id: remotes.request.id,
      type: 'result',
      value: gitSuccess([{ authorized: true, fetchUrl: 'https://git.example/team/app.git', name: 'origin' }])
    })
    loop.runTurn()
    expect(await result).toEqual({
      error: null,
      stderr: '',
      stdout: 'remote.origin.url https://git.example/team/app.git\n'
    })
    expect(port.closedResources).toHaveLength(1)
  })

  it('survives post-import intrinsic poisoning without dispatching an unsupported command', async () => {
    const git = createGit()
    const child = ChildProcessPublic.createChildProcessSyntheticModule({ git: git.facade })
    const originals = {
      call: Function.prototype.call,
      indexOf: Array.prototype.indexOf,
      push: Array.prototype.push,
      iterator: Array.prototype[Symbol.iterator],
      setHas: Set.prototype.has,
      weakAdd: WeakSet.prototype.add,
      weakHas: WeakSet.prototype.has,
      keys: Object.keys,
      hasOwn: Object.hasOwn,
      descriptor: Object.getOwnPropertyDescriptor,
      then: Promise.prototype.then,
      charCodeAt: String.prototype.charCodeAt
    }
    try {
      Function.prototype.call = (() => {
        throw new Error('poison')
      }) as never
      Array.prototype.indexOf = (() => {
        throw new Error('poison')
      }) as never
      Array.prototype.push = (() => {
        throw new Error('poison')
      }) as never
      Array.prototype[Symbol.iterator] = (() => {
        throw new Error('poison')
      }) as never
      Set.prototype.has = (() => {
        throw new Error('poison')
      }) as never
      WeakSet.prototype.add = (() => {
        throw new Error('poison')
      }) as never
      WeakSet.prototype.has = (() => {
        throw new Error('poison')
      }) as never
      Object.keys = (() => {
        throw new Error('poison')
      }) as never
      Object.hasOwn = (() => {
        throw new Error('poison')
      }) as never
      Object.getOwnPropertyDescriptor = (() => {
        throw new Error('poison')
      }) as never
      Promise.prototype.then = (() => {
        throw new Error('poison')
      }) as never
      String.prototype.charCodeAt = (() => {
        throw new Error('poison')
      }) as never
      child.execFile('git; id', [], {}, () => undefined)
    } finally {
      Function.prototype.call = originals.call
      Array.prototype.indexOf = originals.indexOf
      Array.prototype.push = originals.push
      Array.prototype[Symbol.iterator] = originals.iterator
      Set.prototype.has = originals.setHas
      WeakSet.prototype.add = originals.weakAdd
      WeakSet.prototype.has = originals.weakHas
      Object.keys = originals.keys
      Object.hasOwn = originals.hasOwn
      Object.getOwnPropertyDescriptor = originals.descriptor
      Promise.prototype.then = originals.then
      String.prototype.charCodeAt = originals.charCodeAt
    }
    await Promise.resolve()
    expect(git.facade.open).not.toHaveBeenCalled()
    expect(git.facade.clone).not.toHaveBeenCalled()
  })

  it('ignores Object prototype and numeric helper pollution after import', async () => {
    const base = Object.prototype as Record<string, unknown>
    const originalOpen = base.open
    const originalClone = base.clone
    const originalSafe = Number.isSafeInteger
    const originalMin = Math.min
    try {
      base.open = () => undefined
      base.clone = () => undefined
      Number.isSafeInteger = (() => true) as never
      Math.min = (() => Infinity) as never
      expect(() => ChildProcessPublic.createChildProcessSyntheticModule({ git: {} as GitFacade })).toThrow(
        expect.objectContaining({ code: 'child_process.invalid_argument' })
      )
      const git = createGit([{ authorized: true, fetchUrl: 'https://git.example/team/app.git', name: 'origin' }])
      const child = ChildProcessPublic.createChildProcessSyntheticModule({
        git: git.facade,
        limits: { maxStdoutBytes: 1 }
      })
      expect(
        (await invoke(child.execFile, 'git', [
          '-C',
          'mobile-fs://workspace/a',
          'config',
          '--get-regexp',
          '^remote\\..*\\.url$'
        ], {})).error
      ).toMatchObject({ code: 'child_process.limit_exceeded' })
    } finally {
      base.open = originalOpen
      base.clone = originalClone
      Number.isSafeInteger = originalSafe
      Math.min = originalMin
    }
  })
})
