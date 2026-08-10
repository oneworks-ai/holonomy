import { describe, expect, it } from 'vitest'

import {
  GIT_OPERATIONS,
  RuntimeEventLoop,
  createGitAuthority,
  createGitAuthorityRegistry,
  createGitFacade,
  createNativeBridge,
  gitFailure,
  gitSuccess,
  nativeAuthorityForGit,
  requireGitRepositoryBinding,
  resolveProviderGitAuthority
} from '../src/index.js'
import { gitAuthorityInput } from './git-fixture.js'
import { ControlledNativePort, VirtualNativeHost, providerToken } from './native-port-fixture.js'

import type { GitRepository, NativeProviderToken, RuntimeEventLoop as RuntimeEventLoopType } from '../src/index.js'
import type { NativePortCall } from './native-port-fixture.js'

const settle = async <T>(loop: RuntimeEventLoopType, promise: Promise<T>) => {
  let settled = false
  let failure: unknown
  let value!: T
  void promise.then(result => {
    settled = true
    value = result
  }, error => {
    settled = true
    failure = error
  })
  for (let index = 0; index < 128; index += 1) {
    if (settled) break
    if (loop.getSnapshot().hasPendingWork) loop.runTurn()
    await Promise.resolve()
  }
  if (!settled) throw new Error('Git facade promise did not settle')
  if (failure !== undefined) throw failure
  return value
}

const setup = () => {
  const authority = createGitAuthority(gitAuthorityInput())
  const host = new VirtualNativeHost()
  const loop = new RuntimeEventLoop(host)
  const port = new ControlledNativePort()
  const bridge = createNativeBridge(port, {
    authority: nativeAuthorityForGit(authority),
    eventLoop: loop
  })
  const facade = createGitFacade({ authority: gitAuthorityInput(), bridge })
  return { authority, bridge, facade, host, loop, port }
}

const latest = (port: ControlledNativePort) => port.calls.at(-1) as NativePortCall

const completeRepository = (
  loop: RuntimeEventLoopType,
  call: NativePortCall,
  token: NativeProviderToken
) => {
  call.sink({
    id: call.request.id,
    resources: [{ providerToken: token, type: 'git.repository' }],
    type: call.context.mode === 'stream' ? 'end' : 'result',
    value: gitSuccess({ repository: true })
  })
  loop.runTurn()
}

const openRepository = async (test: ReturnType<typeof setup>): Promise<GitRepository> => {
  const pending = test.facade.open('mobile-fs://workspace/project')
  completeRepository(test.loop, latest(test.port), providerToken('repo-1'))
  return settle(test.loop, pending)
}

describe('git v1 opaque repository facade', () => {
  it('passes only an opaque resource binding and re-authorizable host context', async () => {
    const test = setup()
    const repository = await openRepository(test)
    const registry = createGitAuthorityRegistry([test.authority])
    const status = repository.status()
    const call = latest(test.port)

    expect(call.request.operation).toBe(GIT_OPERATIONS.status)
    expect(call.request.args).toEqual({ repository: { resource: expect.any(String) } })
    expect(call.context.resources).toHaveLength(1)
    expect(call.context.resources[0]?.reference).toBe(
      (call.request.args as { repository: unknown }).repository
    )
    expect(resolveProviderGitAuthority(registry, call.context, 'status')).toBe(test.authority)
    expect(requireGitRepositoryBinding(call.context).reference).toBe(
      (call.request.args as { repository: unknown }).repository
    )

    call.sink({
      id: call.request.id,
      type: 'result',
      value: gitSuccess({
        ahead: 1,
        behind: 0,
        changedFiles: [{ path: 'src/index.ts', staged: false, status: 'modified', unstaged: true }],
        currentBranch: 'main',
        detached: false,
        head: 'a'.repeat(40),
        upstream: 'origin/main'
      })
    })
    test.loop.runTurn()
    await expect(settle(test.loop, status)).resolves.toMatchObject({
      ahead: 1,
      currentBranch: 'main',
      changedFiles: [{ path: 'src/index.ts' }]
    })
    expect(repository.close()).toBe(true)
    expect(repository.close()).toBe(false)
    expect(test.port.closedResources).toHaveLength(1)
  })

  it('delivers bounded progress through Bridge credit and returns clone repository handle', async () => {
    const test = setup()
    const progress: unknown[] = []
    const pending = test.facade.clone({
      credentialRef: 'credential-1',
      depth: 1,
      destination: 'mobile-fs://workspace/cloned',
      url: 'https://git.example/team/app.git'
    }, { deadlineMs: 500, onProgress: item => progress.push(item) })
    const call = latest(test.port)
    expect(call.request.operation).toBe(GIT_OPERATIONS.clone)
    expect(call.request.deadlineMs).toBe(500)
    expect(test.port.credits).toHaveLength(1)

    call.sink({
      id: call.request.id,
      sequence: 0,
      type: 'chunk',
      value: { completed: 10, phase: 'receive', total: 20, unit: 'objects' }
    })
    test.loop.runTurn()
    await Promise.resolve()
    await Promise.resolve()
    expect(test.port.credits).toHaveLength(2)
    completeRepository(test.loop, call, providerToken('repo-clone'))
    const repository = await settle(test.loop, pending)

    expect(progress).toEqual([{ completed: 10, phase: 'receive', total: 20, unit: 'objects' }])
    expect(repository.close()).toBe(true)
  })

  it('exposes only allowlisted config, redacted remotes and phased fetch/push', async () => {
    const test = setup()
    const repository = await openRepository(test)

    const config = repository.configGet('user.email')
    let call = latest(test.port)
    call.sink({ id: call.request.id, type: 'result', value: gitSuccess('owner@example.test') })
    test.loop.runTurn()
    await expect(settle(test.loop, config)).resolves.toBe('owner@example.test')
    await expect(repository.configGet('credential.helper')).rejects.toMatchObject({
      code: 'git.authorization_denied'
    })

    const remotes = repository.listRemotes()
    call = latest(test.port)
    call.sink({
      id: call.request.id,
      type: 'result',
      value: gitSuccess([{
        authorized: true,
        fetchUrl: 'https://git.example/team/app.git',
        name: 'origin',
        pushUrl: 'https://git.example/team/app.git'
      }])
    })
    test.loop.runTurn()
    await expect(settle(test.loop, remotes)).resolves.toEqual([{
      authorized: true,
      fetchUrl: 'https://git.example/team/app.git',
      name: 'origin',
      pushUrl: 'https://git.example/team/app.git'
    }])

    const fetch = repository.fetch({ credentialRef: 'credential-1', prune: true, remote: 'origin' })
    call = latest(test.port)
    expect(call.request.args).toMatchObject({ credentialRef: 'credential-1', prune: true, remote: 'origin' })
    call.sink({
      id: call.request.id,
      type: 'end',
      value: gitSuccess({ head: 'b'.repeat(40), updatedRefs: ['refs/heads/main'] })
    })
    test.loop.runTurn()
    await expect(settle(test.loop, fetch)).resolves.toEqual({
      head: 'b'.repeat(40),
      updatedRefs: ['refs/heads/main']
    })

    const push = repository.push({
      credentialRef: 'credential-1',
      destinationRef: 'refs/heads/main',
      remote: 'origin',
      setUpstream: true,
      sourceRef: 'refs/heads/main'
    })
    call = latest(test.port)
    expect(call.request.args).toMatchObject({
      credentialRef: 'credential-1',
      destinationRef: 'refs/heads/main',
      remote: 'origin',
      setUpstream: true,
      sourceRef: 'refs/heads/main'
    })
    call.sink({
      id: call.request.id,
      type: 'end',
      value: gitSuccess({ remoteRefs: ['refs/heads/main'], updated: true })
    })
    test.loop.runTurn()
    await expect(settle(test.loop, push)).resolves.toEqual({
      remoteRefs: ['refs/heads/main'],
      updated: true
    })
    repository.close()
  })

  it('maps cancellation and provider failures to stable redacted errors', async () => {
    const test = setup()
    const controller = new AbortController()
    const cancelled = test.facade.open('mobile-fs://workspace/cancelled', { signal: controller.signal })
    controller.abort()
    await expect(settle(test.loop, cancelled)).rejects.toMatchObject({
      code: 'git.cancelled',
      message: 'Git operation was cancelled'
    })

    const failed = test.facade.open('mobile-fs://workspace/private')
    const call = latest(test.port)
    call.sink({
      id: call.request.id,
      type: 'result',
      value: gitFailure('git.authentication_failed')
    })
    test.loop.runTurn()
    await expect(settle(test.loop, failed)).rejects.toMatchObject({
      code: 'git.authentication_failed',
      message: 'Git authentication failed'
    })
  })

  it('snapshots operation/options objects once without invoking getters and preserves timeout', async () => {
    const test = setup()
    const input = { url: 'https://git.example/team/app.git' } as Record<string, unknown>
    let destinationGets = 0
    Object.defineProperty(input, 'destination', {
      enumerable: true,
      get() {
        destinationGets += 1
        throw new Error('native:/private/credential/detail')
      }
    })
    await expect(test.facade.clone(input as never)).rejects.toMatchObject({ code: 'git.invalid_argument' })
    expect(destinationGets).toBe(0)
    await expect(test.facade.clone(input as never)).rejects.not.toThrow('native:/private/credential/detail')

    let deadlineGets = 0
    const hostileOptions = {} as Record<string, unknown>
    Object.defineProperty(hostileOptions, 'deadlineMs', {
      enumerable: true,
      get() {
        deadlineGets += 1
        return deadlineGets === 1 ? undefined : 500
      }
    })
    hostileOptions.timeoutMs = 1
    await expect(test.facade.open('mobile-fs://workspace/timeout', hostileOptions as never)).rejects.toMatchObject({
      code: 'git.invalid_argument'
    })
    expect(deadlineGets).toBe(0)

    const timeout = test.facade.open('mobile-fs://workspace/timeout', { deadlineMs: 500, timeoutMs: 1 })
    expect(latest(test.port).request.deadlineMs).toBe(1)
    test.host.advanceTo(1)
    test.loop.runTurn()
    await expect(settle(test.loop, timeout)).rejects.toMatchObject({ code: 'git.timeout' })
  })

  it('closes unexpected resources and rejects binary on every decoded result shape', async () => {
    const test = setup()
    const repository = await openRepository(test)
    const failed = repository.status()
    let call = latest(test.port)
    call.sink({
      id: call.request.id,
      resources: [{ providerToken: providerToken('unexpected-failure'), type: 'git.repository' }],
      type: 'result',
      value: gitFailure('git.authentication_failed')
    })
    test.loop.runTurn()
    await expect(settle(test.loop, failed)).rejects.toMatchObject({ code: 'git.authentication_failed' })
    expect(test.port.closedResources).toContainEqual(expect.objectContaining({ providerToken: 'unexpected-failure' }))
    expect(test.bridge.getSnapshot().openResources).toBe(1)

    const binary = repository.status()
    call = latest(test.port)
    call.sink({
      binary: [{ data: new Uint8Array([1]), handle: 'unexpected-binary' }],
      id: call.request.id,
      type: 'result',
      value: gitSuccess({
        ahead: 0,
        behind: 0,
        changedFiles: [],
        currentBranch: 'main',
        detached: false,
        head: 'a'.repeat(40),
        upstream: 'origin/main'
      })
    })
    test.loop.runTurn()
    await expect(settle(test.loop, binary)).rejects.toMatchObject({ code: 'git.protocol_error' })
    repository.close()
  })

  it('enforces UTF-8 config and byte-progress limits and exact OID widths', async () => {
    const authorityInput = gitAuthorityInput() as unknown as Record<string, unknown>
    authorityInput.limits = { maxConfigValueBytes: 4, maxTransferBytes: 10 }
    const authority = createGitAuthority(authorityInput as never)
    const host = new VirtualNativeHost()
    const loop = new RuntimeEventLoop(host)
    const port = new ControlledNativePort()
    const bridge = createNativeBridge(port, { authority: nativeAuthorityForGit(authority), eventLoop: loop })
    const facade = createGitFacade({ authority: authorityInput as never, bridge })
    const test = { authority, bridge, facade, host, loop, port }
    const repository = await openRepository(test)

    const originalCharCodeAt = String.prototype.charCodeAt
    // eslint-disable-next-line no-extend-native -- verifies the imported UTF-8 helper captured its intrinsic.
    String.prototype.charCodeAt = () => 0
    try {
      const config = repository.configGet('user.email')
      const call = latest(port)
      call.sink({ id: call.request.id, type: 'result', value: gitSuccess('💣💣') })
      loop.runTurn()
      await expect(settle(loop, config)).rejects.toMatchObject({ code: 'git.limit_exceeded' })
    } finally {
      // eslint-disable-next-line no-extend-native -- restores the test-only prototype mutation.
      String.prototype.charCodeAt = originalCharCodeAt
    }

    const fetch = repository.fetch({ remote: 'origin' })
    let call = latest(port)
    call.sink({
      id: call.request.id,
      sequence: 0,
      type: 'chunk',
      value: { completed: 1, phase: 'receive', total: 11, unit: 'bytes' }
    })
    loop.runTurn()
    await expect(settle(loop, fetch)).rejects.toMatchObject({ code: 'git.protocol_error' })

    const status = repository.status()
    call = latest(port)
    call.sink({
      id: call.request.id,
      type: 'result',
      value: gitSuccess({
        ahead: 0,
        behind: 0,
        changedFiles: [],
        currentBranch: 'main',
        detached: false,
        head: 'a'.repeat(41),
        upstream: 'origin/main'
      })
    })
    loop.runTurn()
    await expect(settle(loop, status)).rejects.toMatchObject({ code: 'git.protocol_error' })
    repository.close()
  })

  it('closes malformed progress resources before rejecting the stream', async () => {
    const test = setup()
    const repository = await openRepository(test)
    const fetch = repository.fetch({ remote: 'origin' })
    const call = latest(test.port)
    call.sink({
      id: call.request.id,
      resources: [{ providerToken: providerToken('unexpected-progress'), type: 'git.repository' }],
      sequence: 0,
      type: 'chunk',
      value: { completed: 1, phase: 'receive', total: 2, unit: 'objects' }
    })
    test.loop.runTurn()
    await expect(settle(test.loop, fetch)).rejects.toMatchObject({ code: 'git.protocol_error' })
    expect(test.port.closedResources).toContainEqual(expect.objectContaining({ providerToken: 'unexpected-progress' }))
    expect(test.bridge.getSnapshot().openResources).toBe(1)
    repository.close()
  })

  it('rejects explicit optional wrong types before dispatch and normalizes malformed progress', async () => {
    const test = setup()
    await expect(
      test.facade.clone({ destination: 'mobile-fs://workspace/x', url: 'https://git.example/x', branch: 1 as never })
    ).rejects.toMatchObject({ code: 'git.invalid_argument' })
    expect(test.port.calls).toHaveLength(0)
    const repository = await openRepository(test)
    await expect(repository.fetch({ remote: 'origin', prune: 'yes' as never })).rejects.toMatchObject({
      code: 'git.invalid_argument'
    })
    expect(test.port.calls).toHaveLength(1)
    const fetch = repository.fetch({ remote: 'origin' })
    const call = latest(test.port)
    call.sink({
      id: call.request.id,
      sequence: 0,
      type: 'chunk',
      value: { completed: 1, phase: 'receive', total: null, unit: 'objects' }
    })
    test.loop.runTurn()
    await expect(settle(test.loop, fetch)).rejects.toMatchObject({ code: 'git.protocol_error' })
    repository.close()
  })

  it('treats undefined optionals as omitted and cleans every malformed repository success', async () => {
    const test = setup()
    const open = test.facade.open('mobile-fs://workspace/undefined', { deadlineMs: undefined })
    const call = latest(test.port)
    expect(call.request.deadlineMs).toBeUndefined()
    call.sink({ id: call.request.id, type: 'result', value: gitSuccess({}) })
    test.loop.runTurn()
    await expect(settle(test.loop, open)).rejects.toMatchObject({ code: 'git.protocol_error' })

    const multiple = test.facade.open('mobile-fs://workspace/multiple')
    const multipleCall = latest(test.port)
    multipleCall.sink({
      id: multipleCall.request.id,
      resources: [
        { providerToken: providerToken('bad-repo-1'), type: 'git.repository' },
        { providerToken: providerToken('bad-repo-2'), type: 'git.repository' }
      ],
      type: 'result',
      value: gitSuccess({ repository: true })
    })
    test.loop.runTurn()
    await expect(settle(test.loop, multiple)).rejects.toMatchObject({ code: 'git.protocol_error' })
    expect(test.port.closedResources.filter(item => item.providerToken.startsWith('bad-repo-'))).toHaveLength(2)
    expect(test.bridge.getSnapshot().openResources).toBe(0)
  })

  it('normalizes null remote URLs as provider protocol errors', async () => {
    const test = setup()
    const repository = await openRepository(test)
    const nullUrl = repository.listRemotes()
    const call = latest(test.port)
    call.sink({
      id: call.request.id,
      type: 'result',
      value: gitSuccess([{ authorized: true, fetchUrl: null, name: 'origin' }])
    })
    test.loop.runTurn()
    await expect(settle(test.loop, nullUrl)).rejects.toMatchObject({ code: 'git.protocol_error' })
    repository.close()
  })
})
