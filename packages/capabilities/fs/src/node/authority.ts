import { FS_REQUIRED_CAPABILITY, FS_ROOT_AUTHORITIES } from './constants.js'
import { createFsError, isHolonomyFsError } from './errors.js'

import type { NativeAuthority, NativeDispatchContext } from '@holonomyjs/runtime/native-port/types'
import type {
  FsAuthority,
  FsAuthorityInput,
  FsOperationName,
  FsPermission,
  FsRootAuthority,
  FsRootGrant,
  ParsedFsPath
} from './types.js'

const ID_PATTERN = /^\w[\w.:-]{0,127}$/u
const CAPABILITY_PATTERN = /^[\w@][\w@./:-]{0,127}$/u
const PERMISSIONS = new Set<FsPermission>(['metadata', 'read', 'write'])

const snapshotPlainObject = (value: unknown): Record<string, unknown> => {
  try {
    if (
      value == null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) throw createFsError('EINVAL')
    const snapshot: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw createFsError('EINVAL')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
        throw createFsError('EINVAL')
      }
      snapshot[key] = descriptor.value
    }
    return Object.freeze(snapshot)
  } catch (error) {
    if (isHolonomyFsError(error)) throw error
    throw createFsError('EINVAL')
  }
}

const snapshotArray = (value: unknown): readonly unknown[] => {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw createFsError('EINVAL')
    }
    const snapshot: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
        throw createFsError('EINVAL')
      }
      snapshot.push(descriptor.value)
    }
    if (Reflect.ownKeys(value).some(key => key !== 'length' && !/^\d+$/u.test(String(key)))) {
      throw createFsError('EINVAL')
    }
    return Object.freeze(snapshot)
  } catch (error) {
    if (isHolonomyFsError(error)) throw error
    throw createFsError('EINVAL')
  }
}

const hasSameCapabilities = (
  left: readonly string[],
  right: readonly string[]
) => left.length === right.length && left.every(value => right.includes(value))

export const createFsAuthority = (
  input: FsAuthorityInput
): Readonly<FsAuthority> => {
  const authorityInput = snapshotPlainObject(input)
  const capabilities = snapshotArray(authorityInput.capabilities)
  const rootsInput = snapshotPlainObject(authorityInput.roots)
  if (
    Reflect.ownKeys(authorityInput).length !== 3 ||
    !['capabilities', 'principal', 'roots'].every(key => key in authorityInput) ||
    typeof authorityInput.principal !== 'string' ||
    !ID_PATTERN.test(authorityInput.principal) ||
    capabilities.length > 256 ||
    capabilities.some(
      capability => typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)
    ) ||
    new Set(capabilities).size !== capabilities.length
  ) {
    throw createFsError('EINVAL')
  }

  const roots: Partial<Record<FsRootAuthority, FsRootGrant>> = {}
  for (const key of Reflect.ownKeys(rootsInput)) {
    if (
      typeof key !== 'string' ||
      !(FS_ROOT_AUTHORITIES as readonly string[]).includes(key)
    ) {
      throw createFsError('EINVAL')
    }
    const grant = snapshotPlainObject(rootsInput[key])
    const permissions = snapshotArray(grant.permissions)
    if (
      Reflect.ownKeys(grant).length !== 2 ||
      !['permissions', 'rootId'].every(property => property in grant) ||
      typeof grant.rootId !== 'string' ||
      !ID_PATTERN.test(grant.rootId) ||
      permissions.length === 0 ||
      permissions.some(permission => !PERMISSIONS.has(permission as FsPermission)) ||
      new Set(permissions).size !== permissions.length
    ) {
      throw createFsError('EINVAL')
    }
    roots[key as FsRootAuthority] = Object.freeze({
      permissions: Object.freeze(permissions as FsPermission[]),
      rootId: grant.rootId
    })
  }

  return Object.freeze({
    capabilities: Object.freeze(capabilities as string[]),
    principal: authorityInput.principal,
    roots: Object.freeze(roots)
  })
}

export const nativeAuthorityForFs = (
  authority: Readonly<FsAuthority>
): Readonly<NativeAuthority> =>
  Object.freeze({
    capabilities: authority.capabilities,
    principal: authority.principal
  })

export const createFsAuthorityRegistry = (
  authorities: readonly Readonly<FsAuthority>[]
) => {
  const registry = new Map<string, Readonly<FsAuthority>>()
  for (const authority of authorities) {
    if (registry.has(authority.principal)) throw createFsError('EINVAL')
    registry.set(authority.principal, authority)
  }
  return registry
}

export const resolveProviderAuthority = (
  registry: ReadonlyMap<string, Readonly<FsAuthority>>,
  context: Readonly<NativeDispatchContext>
) => {
  const authority = registry.get(context.authority.principal)
  if (
    authority == null ||
    !context.authority.capabilities.includes(FS_REQUIRED_CAPABILITY) ||
    !hasSameCapabilities(
      authority.capabilities,
      context.authority.capabilities
    )
  ) {
    throw createFsError('EACCES')
  }
  return authority
}

export const authorizeFsPath = (
  authority: Readonly<FsAuthority>,
  path: ParsedFsPath,
  permission: FsPermission,
  syscall?: FsOperationName
) => {
  const grant = authority.roots[path.authority]
  if (grant == null || !grant.permissions.includes(permission)) {
    throw createFsError('EACCES', syscall)
  }
  return grant
}
