import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const androidRoot = resolve(root, 'adapters/android')

const existingAbsoluteDirectory = value =>
  typeof value === 'string' && value !== '' && isAbsolute(value) && existsSync(value)

const existingExecutable = value => {
  try {
    accessSync(value, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveAndroidSdkRoot(adb, environment = process.env, homeDirectory = homedir()) {
  const environmentRoots = [environment.ANDROID_HOME, environment.ANDROID_SDK_ROOT]
  for (const candidate of environmentRoots) {
    if (existingAbsoluteDirectory(candidate)) return resolve(candidate)
  }

  if (
    isAbsolute(adb) && basename(adb) === 'adb' && basename(dirname(adb)) === 'platform-tools' &&
    existingExecutable(adb)
  ) {
    const candidate = dirname(dirname(adb))
    if (existingAbsoluteDirectory(candidate)) return candidate
  }

  for (
    const candidate of [
      resolve(homeDirectory, '.codex/android-sdk'),
      resolve(homeDirectory, 'Library/Android/sdk')
    ]
  ) {
    if (existingAbsoluteDirectory(candidate)) return candidate
  }
  return undefined
}

export function findAdb() {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
    .filter(Boolean)
  const candidates = [
    ...roots.map(value => resolve(value, 'platform-tools/adb')),
    resolve(homedir(), '.codex/android-sdk/platform-tools/adb'),
    resolve(homedir(), 'Library/Android/sdk/platform-tools/adb'),
    'adb'
  ]
  return candidates.find(candidate => candidate === 'adb' || existsSync(candidate)) ?? 'adb'
}

export function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: options.inherit ? 'inherit' : 'pipe'
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${file} failed`).trim())
  return (result.stdout ?? '').trim()
}

export function selectDevice(adb, requested) {
  if (requested) {
    run(adb, ['-s', requested, 'get-state'])
    return requested
  }
  const devices = listDevices(adb)
  if (devices.length !== 1) throw new Error(`Expected exactly one online Android device, found ${devices.length}`)
  return devices[0]
}

export function listDevices(adb) {
  return run(adb, ['devices'])
    .split('\n')
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(([, state]) => state === 'device')
    .map(([serial]) => serial)
}

export function androidBuildEnvironment(adb, environment = process.env, homeDirectory = homedir()) {
  const sdkRoot = resolveAndroidSdkRoot(adb, environment, homeDirectory)
  const {
    ANDROID_HOME: _androidHome,
    ANDROID_SDK_ROOT: _androidSdkRoot,
    ...baseEnvironment
  } = environment
  const javaHome = environment.JAVA_HOME ?? (process.platform === 'darwin'
    ? run('/usr/libexec/java_home', ['-v', '17'])
    : undefined)
  return {
    ...baseEnvironment,
    ...(sdkRoot == null ? {} : { ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot }),
    ...(javaHome ? { JAVA_HOME: javaHome } : {})
  }
}

export function listForwards(adb, serial, socket) {
  return run(adb, ['forward', '--list'])
    .split('\n')
    .filter(Boolean)
    .map(line => line.trim().split(/\s+/))
    .filter(([device, , remote]) => device === serial && remote === `localabstract:${socket}`)
    .map(([, local]) => Number(local.replace('tcp:', '')))
    .filter(Number.isSafeInteger)
}

export function removeForwards(adb, serial, socket) {
  for (const port of listForwards(adb, serial, socket)) {
    run(adb, ['-s', serial, 'forward', '--remove', `tcp:${port}`])
  }
}

export function buildAndInstall(adb, serial, packageName) {
  run('./gradlew', ['--no-daemon', ':e2e:installDebug'], {
    cwd: androidRoot,
    env: androidBuildEnvironment(adb),
    inherit: true
  })
  run(adb, ['-s', serial, 'shell', 'pm', 'path', packageName])
}
