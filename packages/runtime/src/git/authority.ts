/* eslint-disable max-lines -- strict Git authority, credential and provider checks form one security boundary. */

import { authorizeFsPath, createFsAuthority } from '@holonomyjs/capability-fs/node/authority'
import { parseFsPath } from '@holonomyjs/capability-fs/node/path'
import { authorizeNetworkUrl, resolveNetworkAuthority } from '@holonomyjs/capability-network/web/authority'
import { GIT_REPOSITORY_RESOURCE, GIT_REQUIRED_CAPABILITY } from './constants.js'
import { GitRuntimeError, createGitError } from './errors.js'

import type { FsPermission } from '@holonomyjs/capability-fs/node/types'
import type { NativeAuthority, NativeDispatchContext } from '../native-port/types.js'
import type {
  AuthorizedGitPath,
  GitAuthority,
  GitAuthorityInput,
  GitCapability,
  GitCredentialOperation,
  GitLimits
} from './types.js'

export const DEFAULT_GIT_LIMITS: GitLimits = Object.freeze({
  maxChangedFiles: 4096,
  maxConcurrentOperations: 4,
  maxConfigValueBytes: 16 * 1024,
  maxOpenRepositories: 16,
  maxProgressEvents: 10_000,
  maxRefBytes: 1024,
  maxRemotes: 64,
  maxTransferBytes: 256 * 1024 * 1024
})

const ID_PATTERN = /^\w[\w.:-]{0,127}$/u
const CAPABILITY_PATTERN = /^[\w@][\w@./:-]{0,127}$/u
const CONFIG_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/iu
const GIT_CAPABILITIES = new Set<GitCapability>([
  'clone',
  'config.read',
  'fetch',
  'push',
  'remote.read',
  'repository.open',
  'status'
])
const CREDENTIAL_OPERATIONS = new Set<GitCredentialOperation>(['clone', 'fetch', 'push'])
const FS_ROOTS = ['app-data', 'temp', 'workspace'] as const
const NETWORK_LIMITS = [
  'maxChunkBytes',
  'maxConcurrentConnections',
  'maxHeaderBytes',
  'maxHeaders',
  'maxRedirects',
  'maxRequestBodyBytes',
  'maxResponseBodyBytes',
  'maxWebSocketBufferedBytes',
  'maxWebSocketMessageBytes'
] as const
const regexTest = Function.prototype.call.bind(RegExp.prototype.test) as (expression: RegExp, value: string) => boolean
const matches = (expression: RegExp, value: string) => regexTest(expression, value)

export const snapshotGitRecord = (
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = []
) => {
  try {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid record')
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype) throw new Error('invalid record prototype')
    const output: Record<string, unknown> = {}
    for (const key of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor == null) continue
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('invalid record descriptor')
      }
      if (descriptor.value === undefined) continue
      output[key] = descriptor.value
    }
    if (required.some(key => !Object.hasOwn(output, key))) throw new Error('missing record field')
    return output
  } catch {
    throw createGitError('git.invalid_argument')
  }
}

export const snapshotGitArray = (value: unknown, maximum = 256) => {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error('invalid array')
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (
      lengthDescriptor == null || !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximum
    ) throw new Error('invalid array length')
    const length = lengthDescriptor.value
    const output: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('invalid array descriptor')
      }
      output.push(descriptor.value)
    }
    return Object.freeze(output)
  } catch {
    throw createGitError('git.invalid_argument')
  }
}

const stringSet = (
  value: unknown,
  valid: (item: string) => boolean,
  maximum = 256
) => {
  const items = snapshotGitArray(value, maximum)
  if (
    items.length > maximum ||
    items.some(item => typeof item !== 'string' || !valid(item)) ||
    new Set(items).size !== items.length
  ) throw createGitError('git.invalid_argument')
  return Object.freeze(items as string[])
}

const resolveLimits = (value: unknown) => {
  if (value === undefined) return DEFAULT_GIT_LIMITS
  const input = snapshotGitRecord(value, [
    'maxChangedFiles',
    'maxConcurrentOperations',
    'maxConfigValueBytes',
    'maxOpenRepositories',
    'maxProgressEvents',
    'maxRefBytes',
    'maxRemotes',
    'maxTransferBytes'
  ])
  const limits = { ...DEFAULT_GIT_LIMITS, ...input }
  if (
    [
      limits.maxChangedFiles,
      limits.maxConcurrentOperations,
      limits.maxConfigValueBytes,
      limits.maxOpenRepositories,
      limits.maxProgressEvents,
      limits.maxRefBytes,
      limits.maxRemotes,
      limits.maxTransferBytes
    ].some(limit => !Number.isSafeInteger(limit) || limit <= 0)
  ) {
    throw createGitError('git.invalid_argument')
  }
  return Object.freeze(limits as unknown as GitLimits)
}

const snapshotFilesystemAuthority = (value: unknown) => {
  const input = snapshotGitRecord(value, ['capabilities', 'principal', 'roots'], ['capabilities', 'principal', 'roots'])
  const rootsInput = snapshotGitRecord(input.roots, FS_ROOTS)
  const roots: Record<string, unknown> = {}
  for (const root of FS_ROOTS) {
    if (!Object.hasOwn(rootsInput, root)) continue
    const grant = snapshotGitRecord(rootsInput[root], ['permissions', 'rootId'], ['permissions', 'rootId'])
    roots[root] = Object.freeze({ permissions: snapshotGitArray(grant.permissions), rootId: grant.rootId })
  }
  return Object.freeze({
    capabilities: snapshotGitArray(input.capabilities),
    principal: input.principal,
    roots: Object.freeze(roots)
  })
}

const snapshotNetworkAuthority = (value: unknown) => {
  const input = snapshotGitRecord(value, ['allowedOrigins', 'allowedSchemes', 'limits', 'privateNetwork'], [
    'allowedOrigins'
  ])
  const limits = Object.hasOwn(input, 'limits') ? snapshotGitRecord(input.limits, NETWORK_LIMITS) : undefined
  return Object.freeze({
    allowedOrigins: snapshotGitArray(input.allowedOrigins),
    ...(Object.hasOwn(input, 'allowedSchemes') ? { allowedSchemes: snapshotGitArray(input.allowedSchemes) } : {}),
    ...(limits == null ? {} : { limits: Object.freeze(limits) }),
    ...(Object.hasOwn(input, 'privateNetwork') ? { privateNetwork: input.privateNetwork } : {})
  })
}

const normalizeCredentialOrigin = (
  origin: string,
  network: GitAuthority['network']
) => {
  const url = authorizeNetworkUrl(network, origin, 'http')
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw createGitError('git.invalid_remote')
  }
  return url.origin
}

export const createGitAuthority = (input: GitAuthorityInput): Readonly<GitAuthority> => {
  try {
    const allowedKeys = [
      'capabilities',
      'configKeys',
      'credentials',
      'filesystem',
      'limits',
      'network',
      'operations',
      'principal'
    ]
    const value = snapshotGitRecord(input, allowedKeys, [
      'capabilities',
      'configKeys',
      'filesystem',
      'network',
      'operations',
      'principal'
    ])
    if (typeof value.principal !== 'string' || !matches(ID_PATTERN, value.principal)) {
      throw new Error('invalid principal')
    }
    const capabilities = stringSet(value.capabilities, item => matches(CAPABILITY_PATTERN, item))
    if (!capabilities.includes(GIT_REQUIRED_CAPABILITY)) throw new Error('missing Git capability')
    const operations = stringSet(
      value.operations,
      item => GIT_CAPABILITIES.has(item as GitCapability),
      GIT_CAPABILITIES.size
    ) as readonly GitCapability[]
    const configKeys = stringSet(value.configKeys, item => matches(CONFIG_KEY_PATTERN, item))
    const filesystem = createFsAuthority(
      snapshotFilesystemAuthority(value.filesystem) as GitAuthorityInput['filesystem']
    )
    if (
      filesystem.principal !== value.principal ||
      filesystem.capabilities.length !== capabilities.length ||
      !filesystem.capabilities.every(item => capabilities.includes(item))
    ) throw new Error('filesystem authority mismatch')
    const network = resolveNetworkAuthority(snapshotNetworkAuthority(value.network) as GitAuthorityInput['network'])
    if (network.allowedSchemes.some(scheme => scheme !== 'http' && scheme !== 'https')) {
      throw new Error('unsupported Git network scheme')
    }
    const credentialsInput = Object.hasOwn(value, 'credentials') ? value.credentials : []
    const credentials = snapshotGitArray(credentialsInput).map(item => {
      const grant = snapshotGitRecord(item, ['allowedOrigins', 'operations', 'reference'], [
        'allowedOrigins',
        'operations',
        'reference'
      ])
      if (
        typeof grant.reference !== 'string' ||
        !matches(ID_PATTERN, grant.reference)
      ) throw new Error('invalid credential grant')
      const grantOperations = stringSet(
        grant.operations,
        operation => CREDENTIAL_OPERATIONS.has(operation as GitCredentialOperation),
        CREDENTIAL_OPERATIONS.size
      ) as readonly GitCredentialOperation[]
      const origins = stringSet(grant.allowedOrigins, origin => typeof origin === 'string')
        .map(origin => normalizeCredentialOrigin(origin, network))
      return Object.freeze({
        allowedOrigins: Object.freeze(origins),
        operations: grantOperations,
        reference: grant.reference
      })
    })
    if (new Set(credentials.map(item => item.reference)).size !== credentials.length) {
      throw new Error('duplicate credential reference')
    }
    return Object.freeze({
      capabilities,
      configKeys,
      credentials: Object.freeze(credentials),
      filesystem,
      limits: Object.hasOwn(value, 'limits') ? resolveLimits(value.limits) : DEFAULT_GIT_LIMITS,
      network,
      operations,
      principal: value.principal
    })
  } catch (error) {
    if (error instanceof GitRuntimeError) throw error
    throw createGitError('git.invalid_argument')
  }
}

export const nativeAuthorityForGit = (
  authority: Readonly<GitAuthority>
): Readonly<NativeAuthority> =>
  Object.freeze({
    capabilities: authority.capabilities,
    principal: authority.principal
  })

export const createGitAuthorityRegistry = (
  authorities: readonly Readonly<GitAuthority>[]
) => {
  const registry = new Map<string, Readonly<GitAuthority>>()
  for (const authority of authorities) {
    if (registry.has(authority.principal)) throw createGitError('git.invalid_argument')
    registry.set(authority.principal, authority)
  }
  return registry
}

export const resolveProviderGitAuthority = (
  registry: ReadonlyMap<string, Readonly<GitAuthority>>,
  context: Readonly<NativeDispatchContext>,
  operation: GitCapability
) => {
  const authority = registry.get(context.authority.principal)
  if (
    authority == null ||
    !context.authority.capabilities.includes(GIT_REQUIRED_CAPABILITY) ||
    authority.capabilities.length !== context.authority.capabilities.length ||
    !authority.capabilities.every(item => context.authority.capabilities.includes(item)) ||
    !authority.operations.includes(operation)
  ) throw createGitError('git.authorization_denied')
  return authority
}

export const assertGitCapability = (
  authority: Readonly<GitAuthority>,
  operation: GitCapability
) => {
  if (!authority.operations.includes(operation)) throw createGitError('git.authorization_denied')
}

export const requireGitRepositoryBinding = (
  context: Readonly<NativeDispatchContext>
) => {
  if (context.resources.length !== 1 || context.resources[0]?.type !== GIT_REPOSITORY_RESOURCE) {
    throw createGitError('git.authorization_denied')
  }
  return context.resources[0]
}

export const authorizeGitPath = (
  authority: Readonly<GitAuthority>,
  path: string,
  permission: FsPermission
): AuthorizedGitPath => {
  try {
    const parsed = parseFsPath(path)
    if (parsed.authority !== 'workspace') throw createGitError('git.invalid_path')
    const grant = authorizeFsPath(authority.filesystem, parsed, permission)
    return Object.freeze({ href: parsed.href, permission, rootId: grant.rootId })
  } catch {
    throw createGitError('git.invalid_path')
  }
}

export const authorizeGitRemoteUrl = (
  authority: Readonly<GitAuthority>,
  input: string
) => {
  try {
    const url = authorizeNetworkUrl(authority.network, input, 'http')
    if (url.username !== '' || url.password !== '') throw new Error('embedded credentials')
    return url.toString()
  } catch {
    throw createGitError('git.invalid_remote')
  }
}

export const authorizeGitCredential = (
  authority: Readonly<GitAuthority>,
  reference: string | undefined,
  operation: GitCredentialOperation,
  remoteUrl: string
) => {
  const credential = authorizeGitCredentialReference(authority, reference, operation)
  if (credential == null) return undefined
  const origin = new URL(authorizeGitRemoteUrl(authority, remoteUrl)).origin
  const grant = authority.credentials.find(item => item.reference === credential)
  if (grant == null || !grant.allowedOrigins.includes(origin)) {
    throw createGitError('git.authorization_denied')
  }
  return grant.reference
}

export const authorizeGitCredentialReference = (
  authority: Readonly<GitAuthority>,
  reference: string | undefined,
  operation: GitCredentialOperation
) => {
  if (reference == null) return undefined
  const grant = authority.credentials.find(item => item.reference === reference)
  if (grant == null || !grant.operations.includes(operation)) {
    throw createGitError('git.authorization_denied')
  }
  return grant.reference
}

export const authorizeGitConfigKey = (
  authority: Readonly<GitAuthority>,
  key: string
) => {
  if (typeof key !== 'string' || !authority.configKeys.includes(key)) {
    throw createGitError('git.authorization_denied')
  }
  return key
}
