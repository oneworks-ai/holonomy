import { spawn, spawnSync } from 'node:child_process'
import { constants, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { CapabilityInvocationError } from '../../../dist/capability-runtime/index.js'

const SYSTEM_EXECUTABLE_ROOTS = Object.freeze(['/bin/', '/System/', '/usr/bin/', '/usr/lib/'])

const unavailable = operation => {
  throw new CapabilityInvocationError('provider.unavailable', operation)
}

const sbplString = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

const subpath = (candidate, root) => candidate === root || candidate.startsWith(`${root}${path.sep}`)

const runtimeOwnsExecutable = (backend, executablePath) =>
  SYSTEM_EXECUTABLE_ROOTS.some(root => executablePath.startsWith(root)) ||
  backend.runtimeReadPaths.some(root => subpath(executablePath, root))

const executable = value => {
  try {
    const stat = statSync(value)
    return stat.isFile() && (stat.mode & constants.X_OK) !== 0
  } catch {
    return false
  }
}

const normalizeExecutable = value => {
  if (
    value == null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['kind', 'path'].includes(key)) || value.kind !== 'hostPath' ||
    typeof value.path !== 'string' || value.path.length === 0 || value.path.length > 4096 ||
    value.path.includes('\0') || !path.isAbsolute(value.path) || path.normalize(value.path) !== value.path
  ) throw new TypeError('Invalid Node capability Runtime session')
  return Object.freeze({ kind: 'hostPath', path: value.path })
}

const seatbeltProfile = (backend, executablePath) =>
  [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(deny process-fork)',
    '(deny network*)',
    `(allow process-exec (literal ${sbplString(executablePath)}))`,
    `(allow file-read* file-map-executable (literal ${sbplString(executablePath)})${
      backend.runtimeReadPaths.map(value => ` (subpath ${sbplString(value)})`).join('')
    })`
  ].join('')

const normalizeConfiguration = value => {
  if (process.platform !== 'darwin') throw new TypeError('Invalid Node capability Runtime session')
  if (
    value == null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['runtimeReadPaths', 'sandboxExecutablePath'].includes(key))
  ) throw new TypeError('Invalid Node capability Runtime session')
  const sandboxExecutablePath = value.sandboxExecutablePath
  if (
    typeof sandboxExecutablePath !== 'string' || !path.isAbsolute(sandboxExecutablePath) ||
    path.normalize(sandboxExecutablePath) !== sandboxExecutablePath || sandboxExecutablePath.includes('\0')
  ) throw new TypeError('Invalid Node capability Runtime session')
  if (!Array.isArray(value.runtimeReadPaths) || value.runtimeReadPaths.length > 64) {
    throw new TypeError('Invalid Node capability Runtime session')
  }
  const runtimeReadPaths = value.runtimeReadPaths.map(item => {
    if (
      typeof item !== 'string' || item.length === 0 || item.length > 4096 || item.includes('\0') ||
      !path.isAbsolute(item) || path.normalize(item) !== item ||
      ['/', '/Users', '/Volumes', '/private', '/tmp', '/var', '/etc', '/home'].includes(item)
    ) throw new TypeError('Invalid Node capability Runtime session')
    return item
  }).sort()
  if (new Set(runtimeReadPaths).size !== runtimeReadPaths.length) {
    throw new TypeError('Invalid Node capability Runtime session')
  }
  return Object.freeze({
    runtimeReadPaths: Object.freeze(runtimeReadPaths),
    sandboxExecutablePath
  })
}

const prepareLaunch = ({
  configuration,
  environmentScope,
  executable: executableLocator,
  operation,
  policy,
  runtimeArgs
}) => {
  const executablePath = executableLocator?.kind === 'hostPath' ? executableLocator.path : undefined
  if (
    process.platform !== 'darwin' ||
    environmentScope !== 'processTree' ||
    !executable(configuration.sandboxExecutablePath) || !executable(executablePath) ||
    !runtimeOwnsExecutable(configuration, executablePath) || policy.mounts.length !== 0 ||
    policy.network.access !== 'none' || policy.limits.maxWritableRootfsBytes !== 0
  ) unavailable(operation)
  return Object.freeze({
    args: Object.freeze([
      '-p',
      seatbeltProfile(configuration, executablePath),
      executablePath,
      ...runtimeArgs
    ]),
    cwd: '/',
    executablePath: configuration.sandboxExecutablePath
  })
}

export const DARWIN_SEATBELT_PROCESS_BACKEND_V1 = Object.freeze({
  descriptor: Object.freeze({
    backendId: 'native.darwin-seatbelt-v1',
    binaryFormats: Object.freeze(['host-native']),
    environmentScopes: Object.freeze(['processTree']),
    family: 'native',
    features: Object.freeze({
      filesystemBridge: false,
      networkBridge: false,
      pty: false,
      shell: true,
      signals: true,
      snapshots: false,
      synchronousSpawn: true
    }),
    platforms: Object.freeze(['desktop', 'node']),
    stability: 'stable',
    version: 1
  }),
  closeGeneration() {},
  normalizeConfiguration,
  normalizeExecutable,
  validateProfile(profile) {
    if (
      !executable(profile.backend.configuration.sandboxExecutablePath) ||
      profile.executables.some(item =>
        item.executable.kind !== 'hostPath' || !executable(item.executable.path) ||
        !runtimeOwnsExecutable(profile.backend.configuration, item.executable.path)
      )
    ) throw new TypeError('Invalid Node capability Runtime session')
  },
  prepareLaunch,
  spawn(launch, options) {
    const child = spawn(launch.executablePath, launch.args, options)
    return Object.freeze({
      child,
      killTree(signal) {
        try {
          if (process.platform !== 'win32' && child.pid != null) process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch {
          child.kill(signal)
        }
      }
    })
  },
  spawnSync(launch, options) {
    return spawnSync(launch.executablePath, launch.args, options)
  }
})
