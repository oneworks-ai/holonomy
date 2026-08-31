import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'

const invalid = message => {
  throw new TypeError(`Invalid v86 image contract: ${message}`)
}
const exact = (value, keys, name) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalid(name)
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid(name)
  return value
}
const PROFILE_ID = /^(?:agent|base|minimal|custom\.[a-z\d][a-z\d.-]{0,63})$/u
const PACKAGE = /^[a-z\d][a-z\d+_.-]{0,127}$/u
const EXECUTABLE_ID = /^[a-z][a-z\d.-]{0,63}$/u
const SHA256 = /^[a-f\d]{64}$/u

export const sha256 = value => createHash('sha256').update(value).digest('hex')

export const canonicalJson = value => `${JSON.stringify(value, null, 2)}\n`

export const normalizeImageProfileV1 = value => {
  const input = exact(value, ['executables', 'id', 'packages', 'rootfs', 'schemaVersion'], 'profile')
  if (input.schemaVersion != null && input.schemaVersion !== 1) return invalid('profile version')
  if (!PROFILE_ID.test(input.id) || !['alpine', 'empty'].includes(input.rootfs)) return invalid('profile identity')
  if (
    !Array.isArray(input.packages) || input.packages.length > 256 ||
    input.packages.some(value => typeof value !== 'string' || !PACKAGE.test(value)) ||
    new Set(input.packages).size !== input.packages.length
  ) return invalid('profile packages')
  if (!Array.isArray(input.executables) || input.executables.length > 128) return invalid('executables')
  const executables = input.executables.map(value => {
    const executable = exact(value, ['executableId', 'path', 'shell'], 'executable')
    if (
      !EXECUTABLE_ID.test(executable.executableId) || typeof executable.path !== 'string' ||
      executable.path.includes('\0') || !executable.path.startsWith('/') || executable.path === '/' ||
      executable.path.endsWith('/') || posix.normalize(executable.path) !== executable.path ||
      typeof executable.shell !== 'boolean'
    ) return invalid('executable')
    return Object.freeze({
      executableId: executable.executableId,
      path: executable.path,
      shell: executable.shell
    })
  }).sort((left, right) => left.executableId.localeCompare(right.executableId))
  if (
    new Set(executables.map(value => value.executableId)).size !== executables.length ||
    new Set(executables.map(value => value.path)).size !== executables.length ||
    input.rootfs === 'empty' && (input.packages.length !== 0 || executables.length !== 0)
  ) return invalid('profile projection')
  return Object.freeze({
    executables: Object.freeze(executables),
    id: input.id,
    packages: Object.freeze([...input.packages].sort()),
    rootfs: input.rootfs,
    schemaVersion: 1
  })
}

export const readImageProfileV1 = async selector => {
  if (['agent', 'base', 'minimal'].includes(selector)) {
    const owner = JSON.parse(await readFile(new URL('./profiles-v1.json', import.meta.url), 'utf8'))
    if (owner?.schemaVersion !== 1 || !Array.isArray(owner.profiles)) return invalid('profile registry')
    const profile = owner.profiles.find(value => value.id === selector)
    if (profile == null) return invalid('profile selection')
    return normalizeImageProfileV1(profile)
  }
  const profile = JSON.parse(await readFile(selector, 'utf8'))
  return normalizeImageProfileV1(profile)
}

export const normalizePackageLockV1 = value => {
  const input = exact(value, ['architecture', 'packages', 'rootfs', 'schemaVersion', 'sourceIndexes'], 'lock')
  if (input.schemaVersion !== 1 || input.architecture !== 'x86' || !Array.isArray(input.packages)) {
    return invalid('lock header')
  }
  const rootfs = exact(input.rootfs, ['sha256', 'url', 'version'], 'rootfs')
  if (!SHA256.test(rootfs.sha256) || typeof rootfs.url !== 'string' || typeof rootfs.version !== 'string') {
    return invalid('rootfs')
  }
  const packages = input.packages.map(value => {
    const item = exact(value, [
      'dependencies',
      'installedBytes',
      'license',
      'name',
      'provides',
      'repository',
      'sha256',
      'size',
      'url',
      'version'
    ], 'package')
    if (
      !PACKAGE.test(item.name) || !SHA256.test(item.sha256) || typeof item.version !== 'string' ||
      typeof item.url !== 'string' || !Number.isSafeInteger(item.size) || item.size <= 0 ||
      !Number.isSafeInteger(item.installedBytes) || item.installedBytes <= 0 ||
      typeof item.license !== 'string' || typeof item.repository !== 'string' ||
      !Array.isArray(item.dependencies) || item.dependencies.some(value => typeof value !== 'string') ||
      !Array.isArray(item.provides) || item.provides.some(value => typeof value !== 'string')
    ) return invalid('package')
    return Object.freeze({ ...item })
  }).sort((left, right) => left.name.localeCompare(right.name))
  if (new Set(packages.map(value => value.name)).size !== packages.length) return invalid('duplicate package')
  return Object.freeze({
    architecture: 'x86',
    packages: Object.freeze(packages),
    rootfs: Object.freeze({ ...rootfs }),
    schemaVersion: 1,
    sourceIndexes: Object.freeze(input.sourceIndexes)
  })
}

export const normalizeKernelLockV1 = value => {
  const input = exact(
    value,
    ['architecture', 'kernel', 'modules', 'package', 'release', 'schemaVersion'],
    'kernel lock'
  )
  if (
    input.schemaVersion !== 1 || input.architecture !== 'x86' ||
    typeof input.release !== 'string' || !/^\d+\.\d+\.\d+-\d+-lts$/u.test(input.release)
  ) return invalid('kernel lock header')
  const kernel = exact(input.kernel, ['archivePath', 'sha256'], 'kernel artifact')
  const packageValue = exact(input.package, ['license', 'name', 'sha256', 'url', 'version'], 'kernel package')
  if (
    typeof kernel.archivePath !== 'string' || !SHA256.test(kernel.sha256) ||
    packageValue.name !== 'linux-lts' || !SHA256.test(packageValue.sha256) ||
    typeof packageValue.license !== 'string' || typeof packageValue.url !== 'string' ||
    typeof packageValue.version !== 'string' || !Array.isArray(input.modules) || input.modules.length === 0
  ) return invalid('kernel package')
  const modules = input.modules.map(value => {
    const module = exact(value, ['archivePath', 'dependencies', 'name', 'sha256'], 'kernel module')
    if (
      typeof module.archivePath !== 'string' || !/^[a-z][a-z\d_-]{0,63}$/u.test(module.name) ||
      !SHA256.test(module.sha256) || !Array.isArray(module.dependencies) ||
      module.dependencies.some(value => typeof value !== 'string' || !/^[a-z][a-z\d_-]{0,63}$/u.test(value)) ||
      new Set(module.dependencies).size !== module.dependencies.length
    ) return invalid('kernel module')
    return Object.freeze({
      archivePath: module.archivePath,
      dependencies: Object.freeze([...module.dependencies]),
      name: module.name,
      sha256: module.sha256
    })
  }).sort((left, right) => left.name.localeCompare(right.name))
  if (new Set(modules.map(value => value.name)).size !== modules.length) return invalid('kernel modules')
  const moduleNames = new Set(modules.map(value => value.name))
  if (modules.some(module => module.dependencies.some(value => !moduleNames.has(value)))) {
    return invalid('kernel module dependency')
  }
  return Object.freeze({
    architecture: 'x86',
    kernel: Object.freeze({ ...kernel }),
    modules: Object.freeze(modules),
    package: Object.freeze({ ...packageValue }),
    release: input.release,
    schemaVersion: 1
  })
}
