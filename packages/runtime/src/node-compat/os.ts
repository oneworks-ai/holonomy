import { invalidArgument } from './errors.js'
import type { RuntimeOsSnapshot, RuntimeUserInfoSnapshot } from './types.js'
import { assertPathWithinVirtualRoot } from './virtual-path.js'

export interface OsCompatApi {
  arch(): string
  homedir(): string
  hostname(): string
  platform(): string
  release(): string
  tmpdir(): string
  type(): string
  userInfo(): RuntimeUserInfoSnapshot
}

export interface OsSyntheticModule extends OsCompatApi {
  readonly default: OsCompatApi
}

const SAFE_IDENTITY = /^[\w-]{1,64}$/u

const cloneSnapshot = (
  input: RuntimeOsSnapshot,
  virtualRoot: string
): RuntimeOsSnapshot => {
  if (input.identityPolicy !== 'synthetic') {
    invalidArgument(
      'os.identityPolicy',
      'OS snapshots must declare synthetic identity values'
    )
  }
  if (!input.arch || !input.platform || !input.release || !input.type) {
    invalidArgument('os snapshot', 'OS arch, platform, release and type are required')
  }
  if (!SAFE_IDENTITY.test(input.hostname) || !SAFE_IDENTITY.test(input.userInfo.username)) {
    invalidArgument(
      'os identity',
      'OS hostname and username must be synthetic portable identifiers'
    )
  }
  if (
    !Number.isSafeInteger(input.userInfo.uid) ||
    input.userInfo.uid < 0 ||
    !Number.isSafeInteger(input.userInfo.gid) ||
    input.userInfo.gid < 0
  ) {
    invalidArgument('os.userInfo', 'OS uid and gid must be non-negative safe integers')
  }
  const homedir = assertPathWithinVirtualRoot(input.homedir, virtualRoot, 'os.homedir')
  const tmpdir = assertPathWithinVirtualRoot(input.tmpdir, virtualRoot, 'os.tmpdir')
  if (input.userInfo.homedir !== input.homedir) {
    invalidArgument(
      'os.userInfo.homedir',
      'OS userInfo homedir must match the synthetic OS homedir'
    )
  }
  const shell = input.userInfo.shell === null
    ? null
    : assertPathWithinVirtualRoot(input.userInfo.shell, virtualRoot, 'os.userInfo.shell')
  const userInfo = Object.freeze({
    ...input.userInfo,
    homedir: assertPathWithinVirtualRoot(
      input.userInfo.homedir,
      virtualRoot,
      'os.userInfo.homedir'
    ),
    shell
  })
  return Object.freeze({ ...input, homedir, tmpdir, userInfo })
}

export const createOsSyntheticModule = (
  input: RuntimeOsSnapshot,
  virtualRoot: string
): OsSyntheticModule => {
  const snapshot = cloneSnapshot(input, virtualRoot)
  const api: OsCompatApi = Object.freeze({
    arch: () => snapshot.arch,
    homedir: () => snapshot.homedir,
    hostname: () => snapshot.hostname,
    platform: () => snapshot.platform,
    release: () => snapshot.release,
    tmpdir: () => snapshot.tmpdir,
    type: () => snapshot.type,
    userInfo: () => snapshot.userInfo
  })
  return Object.freeze({ ...api, default: api })
}
