/* eslint-disable max-lines -- public Git v1 parsing and facade stay together as one reviewed boundary. */

import { utf8ByteLength } from '../node-compat/utf8.js'
import {
  assertGitCapability,
  authorizeGitConfigKey,
  authorizeGitCredential,
  authorizeGitCredentialReference,
  authorizeGitPath,
  authorizeGitRemoteUrl,
  createGitAuthority,
  snapshotGitArray,
  snapshotGitRecord
} from './authority.js'
import { GitBridgeClient } from './bridge-client.js'
import { GIT_OPERATIONS, GIT_REPOSITORY_RESOURCE } from './constants.js'
import { parseGitEnvelope } from './contract.js'
import { createGitError, mapGitBridgeError } from './errors.js'

import type { NativeArgumentValue, NativeResourceHandle, NativeResult } from '../native-port/types.js'
import type { GitErrorCode } from './errors.js'
import type {
  GitAuthority,
  GitCallOptions,
  GitChangedFile,
  GitCloneOptions,
  GitFacade,
  GitFacadeOptions,
  GitFetchOptions,
  GitFetchResult,
  GitPushOptions,
  GitPushResult,
  GitRemote,
  GitRepository,
  GitStatus
} from './types.js'

const REMOTE_PATTERN = /^\w[\w.-]{0,127}$/u
const REF_PATTERN = /^(?:HEAD|refs\/(?:heads|tags)\/\w[\w./-]{0,1023})$/u
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const regexTest = Function.prototype.call.bind(RegExp.prototype.test) as (expression: RegExp, value: string) => boolean
const matches = (expression: RegExp, value: string) => regexTest(expression, value)
const CHANGE_STATUSES = new Set<GitChangedFile['status']>([
  'added',
  'conflicted',
  'deleted',
  'modified',
  'renamed',
  'untracked'
])

const asRecord = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  try {
    return snapshotGitRecord(value, allowed)
  } catch {
    throw createGitError('git.protocol_error')
  }
}

const snapshotInput = (value: unknown, allowed: readonly string[]): Record<string, unknown> =>
  snapshotGitRecord(value, allowed)

const asStringArray = (value: unknown, maximum: number) => {
  try {
    const values = snapshotGitArray(value, maximum)
    if (values.some(item => typeof item !== 'string')) throw new Error('invalid string array')
    return Object.freeze(values as string[])
  } catch {
    throw createGitError('git.protocol_error')
  }
}

const closeResources = (resources: readonly NativeResourceHandle[] | undefined, reason: string) => {
  for (const resource of resources ?? []) {
    try {
      resource.close(reason)
    } catch {}
  }
}

const decodeResult = <T>(result: NativeResult, parse: (value: unknown) => T) => {
  try {
    const envelope = parseGitEnvelope(result)
    if (result.binary?.length || envelope.resources?.length) throw createGitError('git.protocol_error')
    return parse(envelope.value)
  } catch (error) {
    closeResources(result.resources, 'malformed_git_result')
    throw mapGitBridgeError(error)
  }
}

const parseRepository = (
  result: NativeResult,
  client: GitBridgeClient,
  authority: Readonly<GitAuthority>
) => {
  try {
    const output = parseGitEnvelope(result)
    if (result.binary?.length) {
      throw new Error('invalid repository envelope')
    }
    const value = asRecord(output.value, ['repository'])
    if (value.repository !== true) throw new Error('invalid repository envelope')
    const resources = output.resources ?? []
    if (resources.length !== 1 || resources[0]?.type !== GIT_REPOSITORY_RESOURCE) {
      throw new Error('invalid repository resource')
    }
    return new GitRepositoryController(client, authority, resources[0])
  } catch (error) {
    closeResources(result.resources, 'malformed_git_repository')
    const mapped = mapGitBridgeError(error)
    throw mapped.code === 'git.internal' ? createGitError('git.protocol_error') : mapped
  }
}

const repositoryArgs = (
  handle: NativeResourceHandle,
  input: Record<string, NativeArgumentValue> = {}
): NativeArgumentValue => ({ repository: handle, ...input })

const validateRemoteName = (value: unknown, code: GitErrorCode = 'git.invalid_argument') => {
  if (typeof value !== 'string' || !matches(REMOTE_PATTERN, value)) {
    throw createGitError(code)
  }
  return value
}

const validateRef = (
  value: unknown,
  limits: Readonly<GitAuthority>['limits'],
  code: GitErrorCode = 'git.invalid_argument'
) => {
  if (
    typeof value !== 'string' ||
    utf8ByteLength(value) > limits.maxRefBytes ||
    !matches(REF_PATTERN, value) ||
    value.includes('..') ||
    value.includes('//') ||
    value.endsWith('.') ||
    value.endsWith('/')
  ) throw createGitError(code)
  return value
}

const parseFetchResult = (value: unknown, authority: Readonly<GitAuthority>): GitFetchResult => {
  const result = asRecord(value, ['head', 'updatedRefs'])
  const head = result.head
  if (head !== null && (typeof head !== 'string' || !matches(OID_PATTERN, head))) {
    throw createGitError('git.protocol_error')
  }
  return Object.freeze({
    head: head as string | null,
    updatedRefs: asStringArray(result.updatedRefs, authority.limits.maxChangedFiles)
      .map(ref => validateRef(ref, authority.limits, 'git.protocol_error'))
  })
}

const parsePushResult = (value: unknown, authority: Readonly<GitAuthority>): GitPushResult => {
  const result = asRecord(value, ['remoteRefs', 'updated'])
  if (typeof result.updated !== 'boolean') throw createGitError('git.protocol_error')
  return Object.freeze({
    remoteRefs: asStringArray(result.remoteRefs, authority.limits.maxChangedFiles)
      .map(ref => validateRef(ref, authority.limits, 'git.protocol_error')),
    updated: result.updated
  })
}

class GitRepositoryController implements GitRepository {
  constructor(
    private readonly client: GitBridgeClient,
    private readonly authority: Readonly<GitAuthority>,
    private readonly handle: NativeResourceHandle
  ) {}

  close(reason = 'git_repository_closed') {
    return this.handle.close(reason)
  }

  async configGet(key: string, options: GitCallOptions = {}) {
    assertGitCapability(this.authority, 'config.read')
    authorizeGitConfigKey(this.authority, key)
    return decodeResult(
      await this.client.request(
        GIT_OPERATIONS.configGet,
        repositoryArgs(this.handle, { key }),
        options
      ),
      value => {
        if (value !== null && typeof value !== 'string') throw createGitError('git.protocol_error')
        if (typeof value === 'string' && utf8ByteLength(value) > this.authority.limits.maxConfigValueBytes) {
          throw createGitError('git.limit_exceeded')
        }
        return value as string | null
      }
    )
  }

  async fetch(input: GitFetchOptions, options: GitCallOptions = {}) {
    assertGitCapability(this.authority, 'fetch')
    const snapshot = snapshotInput(input, ['credentialRef', 'prune', 'remote'])
    if (typeof snapshot.remote !== 'string') throw createGitError('git.invalid_argument')
    const remote = validateRemoteName(snapshot.remote)
    if (Object.hasOwn(snapshot, 'credentialRef') && typeof snapshot.credentialRef !== 'string') {
      throw createGitError('git.invalid_argument')
    }
    if (Object.hasOwn(snapshot, 'prune') && typeof snapshot.prune !== 'boolean') {
      throw createGitError('git.invalid_argument')
    }
    const credentialRef = authorizeGitCredentialReference(
      this.authority,
      snapshot.credentialRef as string | undefined,
      'fetch'
    )
    return decodeResult(
      await this.client.progressRequest(
        GIT_OPERATIONS.fetch,
        repositoryArgs(this.handle, {
          ...(credentialRef == null ? {} : { credentialRef }),
          ...(Object.hasOwn(snapshot, 'prune') ? { prune: snapshot.prune as boolean } : {}),
          remote
        }),
        options
      ),
      value => parseFetchResult(value, this.authority)
    )
  }

  async listRemotes(options: GitCallOptions = {}) {
    assertGitCapability(this.authority, 'remote.read')
    return decodeResult(
      await this.client.request(
        GIT_OPERATIONS.remoteList,
        repositoryArgs(this.handle),
        options
      ),
      value => {
        let remotes: readonly unknown[]
        try {
          remotes = snapshotGitArray(value, this.authority.limits.maxRemotes)
        } catch {
          throw createGitError('git.protocol_error')
        }
        return Object.freeze(remotes.map(item => {
          const remote = asRecord(item, ['authorized', 'fetchUrl', 'name', 'pushUrl'])
          if (typeof remote.name !== 'string' || typeof remote.authorized !== 'boolean') {
            throw createGitError('git.protocol_error')
          }
          const result: GitRemote = {
            authorized: remote.authorized,
            name: validateRemoteName(remote.name, 'git.protocol_error')
          }
          if (Object.hasOwn(remote, 'fetchUrl')) {
            if (typeof remote.fetchUrl !== 'string') throw createGitError('git.protocol_error')
            try {
              result.fetchUrl = authorizeGitRemoteUrl(this.authority, remote.fetchUrl)
            } catch {
              throw createGitError('git.protocol_error')
            }
          }
          if (Object.hasOwn(remote, 'pushUrl')) {
            if (typeof remote.pushUrl !== 'string') throw createGitError('git.protocol_error')
            try {
              result.pushUrl = authorizeGitRemoteUrl(this.authority, remote.pushUrl)
            } catch {
              throw createGitError('git.protocol_error')
            }
          }
          if (!result.authorized && (result.fetchUrl != null || result.pushUrl != null)) {
            throw createGitError('git.protocol_error')
          }
          return Object.freeze(result)
        }))
      }
    )
  }

  async push(input: GitPushOptions, options: GitCallOptions = {}) {
    assertGitCapability(this.authority, 'push')
    const snapshot = snapshotInput(input, [
      'credentialRef',
      'destinationRef',
      'forceWithLease',
      'remote',
      'setUpstream',
      'sourceRef'
    ])
    if (
      typeof snapshot.destinationRef !== 'string' || typeof snapshot.remote !== 'string' ||
      typeof snapshot.sourceRef !== 'string'
    ) {
      throw createGitError('git.invalid_argument')
    }
    if (Object.hasOwn(snapshot, 'credentialRef') && typeof snapshot.credentialRef !== 'string') {
      throw createGitError('git.invalid_argument')
    }
    if (Object.hasOwn(snapshot, 'forceWithLease') && typeof snapshot.forceWithLease !== 'boolean') {
      throw createGitError('git.invalid_argument')
    }
    if (Object.hasOwn(snapshot, 'setUpstream') && typeof snapshot.setUpstream !== 'boolean') {
      throw createGitError('git.invalid_argument')
    }
    const credentialRef = authorizeGitCredentialReference(
      this.authority,
      snapshot.credentialRef as string | undefined,
      'push'
    )
    return decodeResult(
      await this.client.progressRequest(
        GIT_OPERATIONS.push,
        repositoryArgs(this.handle, {
          ...(credentialRef == null ? {} : { credentialRef }),
          destinationRef: validateRef(snapshot.destinationRef, this.authority.limits),
          ...(Object.hasOwn(snapshot, 'forceWithLease') ? { forceWithLease: snapshot.forceWithLease as boolean } : {}),
          remote: validateRemoteName(snapshot.remote),
          ...(Object.hasOwn(snapshot, 'setUpstream') ? { setUpstream: snapshot.setUpstream as boolean } : {}),
          sourceRef: validateRef(snapshot.sourceRef, this.authority.limits)
        }),
        options
      ),
      value => parsePushResult(value, this.authority)
    )
  }

  async status(options: GitCallOptions = {}) {
    assertGitCapability(this.authority, 'status')
    return decodeResult(
      await this.client.request(
        GIT_OPERATIONS.status,
        repositoryArgs(this.handle),
        options
      ),
      value => this.parseStatus(value)
    )
  }

  private parseStatus(value: unknown): GitStatus {
    const status = asRecord(value, ['ahead', 'behind', 'changedFiles', 'currentBranch', 'detached', 'head', 'upstream'])
    let changedFiles: readonly unknown[]
    try {
      changedFiles = snapshotGitArray(status.changedFiles, this.authority.limits.maxChangedFiles)
    } catch {
      throw createGitError('git.protocol_error')
    }
    if (
      typeof status.ahead !== 'number' || !Number.isSafeInteger(status.ahead) || status.ahead < 0 ||
      typeof status.behind !== 'number' || !Number.isSafeInteger(status.behind) || status.behind < 0 ||
      typeof status.detached !== 'boolean' ||
      (status.currentBranch !== null &&
        (typeof status.currentBranch !== 'string' ||
          utf8ByteLength(status.currentBranch) > this.authority.limits.maxRefBytes)) ||
      (status.upstream !== null &&
        (typeof status.upstream !== 'string' || utf8ByteLength(status.upstream) > this.authority.limits.maxRefBytes)) ||
      (status.head !== null && (typeof status.head !== 'string' || !matches(OID_PATTERN, status.head)))
    ) throw createGitError('git.protocol_error')
    const parsedFiles = changedFiles.map(item => {
      const file = asRecord(item, ['path', 'staged', 'status', 'unstaged'])
      if (
        typeof file.path !== 'string' || utf8ByteLength(file.path) === 0 ||
        utf8ByteLength(file.path) > this.authority.limits.maxRefBytes ||
        file.path.startsWith('/') || file.path.includes('..') || file.path.includes('\\') || file.path.includes('\0') ||
        typeof file.staged !== 'boolean' || typeof file.unstaged !== 'boolean' ||
        !CHANGE_STATUSES.has(file.status as GitChangedFile['status'])
      ) throw createGitError('git.protocol_error')
      return Object.freeze({
        path: file.path,
        staged: file.staged,
        status: file.status as GitChangedFile['status'],
        unstaged: file.unstaged
      })
    })
    return Object.freeze({
      ahead: status.ahead as number,
      behind: status.behind as number,
      changedFiles: Object.freeze(parsedFiles),
      currentBranch: status.currentBranch as string | null,
      detached: status.detached,
      head: status.head as string | null,
      upstream: status.upstream as string | null
    })
  }
}

class GitFacadeController implements GitFacade {
  private readonly authority: Readonly<GitAuthority>
  private readonly client: GitBridgeClient

  constructor(options: GitFacadeOptions) {
    const snapshot = snapshotGitRecord(options, ['authority', 'bridge'], ['authority', 'bridge'])
    this.authority = createGitAuthority(snapshot.authority as GitFacadeOptions['authority'])
    this.client = new GitBridgeClient(snapshot.bridge as GitFacadeOptions['bridge'], this.authority.limits)
  }

  async clone(input: GitCloneOptions, options: GitCallOptions = {}) {
    assertGitCapability(this.authority, 'clone')
    const snapshot = snapshotInput(input, ['branch', 'credentialRef', 'depth', 'destination', 'url'])
    if (typeof snapshot.destination !== 'string' || typeof snapshot.url !== 'string') {
      throw createGitError('git.invalid_argument')
    }
    if (Object.hasOwn(snapshot, 'branch') && typeof snapshot.branch !== 'string') {
      throw createGitError('git.invalid_argument')
    }
    if (Object.hasOwn(snapshot, 'credentialRef') && typeof snapshot.credentialRef !== 'string') {
      throw createGitError('git.invalid_argument')
    }
    const destination = authorizeGitPath(this.authority, snapshot.destination, 'write')
    const url = authorizeGitRemoteUrl(this.authority, snapshot.url)
    const credentialRef = authorizeGitCredential(
      this.authority,
      snapshot.credentialRef as string | undefined,
      'clone',
      url
    )
    if (
      Object.hasOwn(snapshot, 'depth') &&
      (typeof snapshot.depth !== 'number' || !Number.isSafeInteger(snapshot.depth) || snapshot.depth <= 0 ||
        snapshot.depth > 1_000_000)
    ) {
      throw createGitError('git.invalid_argument')
    }
    const result = await this.client.progressRequest(GIT_OPERATIONS.clone, {
      ...(Object.hasOwn(snapshot, 'branch')
        ? { branch: validateRef(`refs/heads/${snapshot.branch as string}`, this.authority.limits) }
        : {}),
      ...(credentialRef == null ? {} : { credentialRef }),
      ...(Object.hasOwn(snapshot, 'depth') ? { depth: snapshot.depth as number } : {}),
      destination: destination.href,
      url
    }, options)
    return parseRepository(result, this.client, this.authority)
  }

  async open(path: string, options: GitCallOptions = {}) {
    assertGitCapability(this.authority, 'repository.open')
    const repository = authorizeGitPath(this.authority, path, 'metadata')
    return parseRepository(
      await this.client.request(GIT_OPERATIONS.open, { path: repository.href }, options),
      this.client,
      this.authority
    )
  }
}

export const createGitFacade = (options: GitFacadeOptions): GitFacade => {
  try {
    return new GitFacadeController(options)
  } catch (error) {
    throw mapGitBridgeError(error)
  }
}
