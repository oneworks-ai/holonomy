import { describe, expect, it } from 'vitest'
import { snapshotGitRecord } from '../../../src/git/authority.js'
import * as GitPublic from '../../../src/git/index.js'

import {
  GIT_CAPABILITY_MATRIX,
  authorizeGitConfigKey,
  authorizeGitCredential,
  authorizeGitPath,
  authorizeGitRemoteUrl,
  createGitAuthority
} from '../../../src/index.js'
import { gitAuthorityInput } from './fixtures.js'

describe('git v1 authority and capability contract', () => {
  it('composes virtual FS, HTTP(S) network and credential-reference grants', () => {
    const authority = createGitAuthority(gitAuthorityInput())

    expect(authorizeGitPath(authority, 'holonomy-fs://workspace/project', 'write')).toEqual({
      href: 'holonomy-fs://workspace/project',
      permission: 'write',
      rootId: 'workspace-1'
    })
    expect(authorizeGitRemoteUrl(authority, 'https://git.example/team/app.git'))
      .toBe('https://git.example/team/app.git')
    expect(authorizeGitCredential(
      authority,
      'credential-1',
      'clone',
      'https://git.example/team/app.git'
    )).toBe('credential-1')
    expect(authorizeGitConfigKey(authority, 'user.email')).toBe('user.email')
  })

  it('rejects native paths, ungranted origins, embedded credentials and credential confusion', () => {
    const authority = createGitAuthority(gitAuthorityInput())

    expect(() => authorizeGitPath(authority, '/data/user/project', 'read'))
      .toThrow(expect.objectContaining({ code: 'git.invalid_path' }))
    expect(() => authorizeGitRemoteUrl(authority, 'ssh://git@git.example/team/app.git'))
      .toThrow(expect.objectContaining({ code: 'git.invalid_remote' }))
    expect(() => authorizeGitRemoteUrl(authority, 'https://user:secret@git.example/team/app.git'))
      .toThrow(expect.objectContaining({ code: 'git.invalid_remote' }))
    expect(() => authorizeGitRemoteUrl(authority, 'https://other.example/team/app.git'))
      .toThrow(expect.objectContaining({ code: 'git.invalid_remote' }))
    expect(() =>
      authorizeGitCredential(
        authority,
        'credential-1',
        'push',
        'https://other.example/team/app.git'
      )
    ).toThrow(expect.objectContaining({ code: 'git.invalid_remote' }))
    expect(() => authorizeGitConfigKey(authority, 'credential.helper'))
      .toThrow(expect.objectContaining({ code: 'git.authorization_denied' }))
  })

  it('declares real consumers, lifecycle owners and unsupported escape hatches', () => {
    expect(GIT_CAPABILITY_MATRIX.consumers).toMatchObject({
      launcherClone: { status: 'supported' },
      managedPluginGitSource: { status: 'partial' },
      sessionGitControls: { status: 'partial' }
    })
    expect(GIT_CAPABILITY_MATRIX.lifecycle.progress).toContain('Native Bridge')
    expect(GIT_CAPABILITY_MATRIX.security.paths).toContain('holonomy-fs://workspace')
    expect(GIT_CAPABILITY_MATRIX.unsupported).toMatchObject({
      arbitraryShell: { status: 'unsupported' },
      credentialHelper: { status: 'unsupported' },
      diff: { status: 'unsupported' },
      gitHooks: { status: 'unsupported' },
      history: { status: 'unsupported' },
      nativePaths: { status: 'unsupported' },
      ssh: { status: 'unsupported' }
    })
    expect(GIT_CAPABILITY_MATRIX.limits).toMatchObject({
      maxConcurrentOperations: expect.stringContaining('provider-owned'),
      maxOpenRepositories: expect.stringContaining('provider-owned'),
      maxTransferBytes: expect.stringContaining('runtime-enforced')
    })
  })

  it('snapshots hostile capability arrays before traversing their indexes', () => {
    let descriptorReads = 0
    let ownKeysCalls = 0
    const capabilities = new Proxy(Array.from({ length: 10_000 }), {
      ownKeys(target) {
        ownKeysCalls += 1
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, key) {
        descriptorReads += 1
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    const input = gitAuthorityInput() as unknown as Record<string, unknown>
    input.capabilities = capabilities

    expect(() => createGitAuthority(input as never)).toThrow(expect.objectContaining({
      code: 'git.invalid_argument'
    }))
    expect(descriptorReads).toBe(1)
    expect(ownKeysCalls).toBe(0)
  })

  it('copies nested FS/network authority records without getter or ownKeys traps', () => {
    const input = gitAuthorityInput() as unknown as Record<string, unknown>
    let ownKeysCalls = 0
    let getterCalls = 0
    input.filesystem = new Proxy(input.filesystem as object, {
      ownKeys(target) {
        ownKeysCalls += 1
        return Reflect.ownKeys(target)
      }
    })
    input.network = {} as never
    Object.defineProperty(input.network, 'allowedOrigins', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error('native:/private/credential')
      }
    })
    expect(() => createGitAuthority(input as never)).toThrow(expect.objectContaining({ code: 'git.invalid_argument' }))
    expect(ownKeysCalls).toBe(0)
    expect(getterCalls).toBe(0)
  })

  it('keeps regex admission captured after prototype poisoning', () => {
    const original = RegExp.prototype.test
    // eslint-disable-next-line no-extend-native -- verifies the captured validator is isolated from later poisoning.
    RegExp.prototype.test = () => true
    try {
      const input = gitAuthorityInput() as unknown as Record<string, unknown>
      input.principal = 'bad principal!'
      expect(() => createGitAuthority(input as never)).toThrow(
        expect.objectContaining({ code: 'git.invalid_argument' })
      )
    } finally {
      // eslint-disable-next-line no-extend-native -- restores the test-only prototype mutation.
      RegExp.prototype.test = original
    }
  })

  it('does not expose internal normalizers from the Git public surface', () => {
    expect(GitPublic).not.toHaveProperty('snapshotGitArray')
    expect(GitPublic).not.toHaveProperty('snapshotGitRecord')
    expect(GitPublic).not.toHaveProperty('parseGitEnvelope')
  })

  it('treats undefined limits as omitted and rejects null limits', () => {
    const omitted = gitAuthorityInput() as unknown as Record<string, unknown>
    omitted.limits = undefined
    expect(createGitAuthority(omitted as never).limits).toEqual(createGitAuthority(gitAuthorityInput()).limits)
    const invalid = gitAuthorityInput() as unknown as Record<string, unknown>
    invalid.limits = null
    expect(() => createGitAuthority(invalid as never)).toThrow(
      expect.objectContaining({ code: 'git.invalid_argument' })
    )
  })

  it('normalizes an own undefined optional data property to omission', () => {
    expect(snapshotGitRecord({ fetchUrl: undefined }, ['fetchUrl'])).not.toHaveProperty('fetchUrl')
  })
})
