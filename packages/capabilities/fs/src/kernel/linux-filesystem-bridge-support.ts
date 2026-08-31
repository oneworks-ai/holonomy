import type { ProcessMountPolicyV2 } from '@holonomyjs/capability-process/kernel/policy-process-types'
import { sha256Hex } from '@holonomyjs/runtime/module-loader/sha256'
import { decodeBase64, encodeBase64 } from '@holonomyjs/runtime/node-compat/encoding'
import type { LinuxFilesystemBridgeInputV1 } from './linux-filesystem-bridge.js'

export const linuxFilesystemFailure = (message: string, errno = 5, code?: string): Error =>
  Object.assign(new Error(message), { errno, ...(code == null ? {} : { code }) })

export const linuxFilesystemErrno = (error: unknown): number => {
  const record = error as { code?: string; errno?: unknown }
  if (Number.isInteger(record?.errno)) return record.errno as number
  return {
    'argument.invalid': 22,
    'capability.denied': 13,
    'middleware.permission_denied': 13,
    'policy.denied': 13,
    'provider.permission_denied': 13,
    'resource.byte_limit': 27,
    'resource.exists': 17,
    'resource.handle_limit': 24,
    'resource.not_found': 2,
    'resource.stale': 9,
    'runtime.cancelled': 4,
    'runtime.generation_stale': 9
  }[record?.code ?? ''] ?? 5
}

export const linuxFilesystemSource = (input: LinuxFilesystemBridgeInputV1) =>
  Object.freeze({
    environmentId: input.environmentId,
    environmentScope: input.scope,
    executableId: input.executableId,
    kind: 'linuxProcess' as const,
    linuxPid: input.linuxPid,
    processResourceId: input.processResourceId,
    syntheticProcessId: input.processId
  })

const canonicalLinuxPath = (value: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || !value.startsWith('/')) {
    throw linuxFilesystemFailure('Invalid Linux guest path', 13)
  }
  const segments = value.slice(1).split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('\0'))) {
    throw linuxFilesystemFailure('Invalid Linux guest path', 13)
  }
  return `/${segments.join('/')}`
}

export const linuxMountedPath = (
  input: LinuxFilesystemBridgeInputV1
): Readonly<{ mount: ProcessMountPolicyV2; virtualUrl: string }> => {
  if (input.policy.access !== 'sandboxed') throw linuxFilesystemFailure('Process filesystem is unavailable', 13)
  const path = canonicalLinuxPath(input.path)
  const mount = [...input.policy.mounts]
    .sort((left, right) => right.guestPath.length - left.guestPath.length)
    .find(item => path === item.guestPath || path.startsWith(`${item.guestPath}/`))
  if (mount == null) throw linuxFilesystemFailure('Linux guest path is not mounted', 13)
  const relative = path.slice(mount.guestPath.length).replace(/^\//u, '')
  const encoded = relative === '' ? '' : relative.split('/').map(encodeURIComponent).join('/')
  return Object.freeze({ mount, virtualUrl: `holo-fs://${mount.rootId}/${encoded}` })
}

export const requireLinuxFilesystemRight = (mount: ProcessMountPolicyV2, right: 'read' | 'write') => {
  if (!mount.rights.includes(right)) throw linuxFilesystemFailure('Process filesystem access is denied', 13)
}

export const linuxOpenFlag = (
  flags: number
): Readonly<{ flag: string; rights: readonly ('read' | 'write')[] }> => {
  if (!Number.isInteger(flags) || flags < 0) throw linuxFilesystemFailure('Unsupported Linux open flags', 22)
  const access = flags & 3
  const create = (flags & 0x40) !== 0
  const exclusive = (flags & 0x80) !== 0
  const truncate = (flags & 0x200) !== 0
  const append = (flags & 0x400) !== 0
  if (access === 3 || exclusive && !create || truncate && access === 0 || append && access === 0) {
    throw linuxFilesystemFailure('Unsupported Linux open flags', 22)
  }
  const rights: readonly ('read' | 'write')[] = access === 0 ? ['read'] : access === 1 ? ['write'] : ['read', 'write']
  const flag = append
    ? access === 2 ? exclusive ? 'ax+' : 'a+' : exclusive ? 'ax' : 'a'
    : create || truncate
    ? access === 2 ? exclusive ? 'wx+' : 'w+' : exclusive ? 'wx' : 'w'
    : access === 0
    ? 'r'
    : 'r+'
  return Object.freeze({ flag, rights })
}

export const encodeLinuxFilesystemData = (value: Uint8Array) =>
  Object.freeze({
    base64: encodeBase64(value, false),
    byteLength: value.byteLength,
    sha256: sha256Hex(value)
  })

export const decodeLinuxFilesystemData = (value: unknown): Uint8Array => {
  if (
    value == null || typeof value !== 'object' || Array.isArray(value) ||
    typeof (value as { base64?: unknown }).base64 !== 'string' ||
    typeof (value as { byteLength?: unknown }).byteLength !== 'number' ||
    typeof (value as { sha256?: unknown }).sha256 !== 'string'
  ) throw linuxFilesystemFailure('Invalid filesystem binary result')
  const record = value as { base64: string; byteLength: number; sha256: string }
  const output = decodeBase64(record.base64)
  if (output.byteLength !== record.byteLength || sha256Hex(output) !== record.sha256) {
    throw linuxFilesystemFailure('Invalid filesystem binary result')
  }
  return output
}
