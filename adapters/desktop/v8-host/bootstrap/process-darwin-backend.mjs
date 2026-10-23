/* eslint-disable max-lines -- Darwin profile normalization and process I/O share one Host owner. */
import { normalizeProcessProfileV1 } from '../../../../packages/capabilities/process/src/host/profile.mjs'

import { NativeProcessBackendRegistryV1 } from './process-backend-registry.mjs'
import { MAX_DARWIN_STDIN_CHUNK_BYTES_V1 } from './process-darwin-command.mjs'

const BACKEND_ID = 'native.darwin-seatbelt-v1'
const SYSTEM_EXECUTABLE_ROOTS = Object.freeze(['/bin/', '/System/', '/usr/bin/', '/usr/lib/'])
const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL'])
const RESULT_SIGNAL = /^SIG[A-Z0-9]{1,16}$/u

const invalid = () => {
  throw new TypeError('Invalid private native Darwin Process profile')
}
const exact = (value, keys) =>
  value != null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key))
const absolutePath = value =>
  typeof value === 'string' && value.length > 1 && value.length <= 4096 &&
  value.startsWith('/') && !value.includes('\0') &&
  value.split('/').slice(1).every(component => component !== '' && component !== '.' && component !== '..')
const subpath = (candidate, root) => candidate === root || candidate.startsWith(`${root}/`)
const runtimeOwnsExecutable = (configuration, path) =>
  SYSTEM_EXECUTABLE_ROOTS.some(root => path.startsWith(root)) ||
  configuration.runtimeReadPaths.some(root => subpath(path, root))

export const NATIVE_DARWIN_PROCESS_DESCRIPTOR_V1 = Object.freeze({
  backendId: BACKEND_ID,
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
  platforms: Object.freeze(['desktop']),
  stability: 'stable',
  version: 1
})

export const normalizeNativeDarwinConfigurationV1 = value => {
  if (!exact(value, ['runtimeReadPaths', 'sandboxExecutablePath'])) return invalid()
  if (!absolutePath(value.sandboxExecutablePath)) return invalid()
  if (
    !Array.isArray(value.runtimeReadPaths) || value.runtimeReadPaths.length > 64 ||
    value.runtimeReadPaths.some(path =>
      !absolutePath(path) ||
      ['/', '/Users', '/Volumes', '/private', '/tmp', '/var', '/etc', '/home'].includes(path)
    ) ||
    new Set(value.runtimeReadPaths).size !== value.runtimeReadPaths.length
  ) return invalid()
  return Object.freeze({
    runtimeReadPaths: Object.freeze([...value.runtimeReadPaths].sort()),
    sandboxExecutablePath: value.sandboxExecutablePath
  })
}

export const normalizeNativeDarwinExecutableV1 = value => {
  if (!exact(value, ['kind', 'path']) || value.kind !== 'hostPath' || !absolutePath(value.path)) {
    return invalid()
  }
  return Object.freeze({ kind: 'hostPath', path: value.path })
}

export const normalizeNativeDarwinProfileV1 = (value, registry) => normalizeProcessProfileV1(value, registry, 'desktop')

export const createNativeDarwinProcessBackendV1 = (command, generation) => {
  if (!Number.isSafeInteger(generation) || generation < 1) return invalid()
  const sinks = new Map()
  let closed = false
  let nextSyncId = 1
  const assertOpen = () => {
    if (closed) return invalid()
  }
  const dispatch = event => {
    if (event.generation !== undefined && event.generation !== generation) return
    const record = sinks.get(event.handle)
    if (record == null) return
    if (record.processResourceId !== event.processResourceId) return invalid()
    const sink = record.sink
    switch (event.kind) {
      case 'stdout':
      case 'stderr':
        sink[event.kind](event.bytes)
        return
      case 'exit':
      case 'close':
        if (
          (event.status !== null && (!Number.isSafeInteger(event.status) || event.status < 0 || event.status > 255)) ||
          (event.signal !== null &&
            (typeof event.signal !== 'string' || !RESULT_SIGNAL.test(event.signal)))
        ) return invalid()
        sink[event.kind](event.status, event.signal)
        if (event.kind === 'close') sinks.delete(event.handle)
        return
      case 'stdinCallback':
        if (
          event.callbackId !== null &&
          (!Number.isSafeInteger(event.callbackId) || event.callbackId < 1)
        ) return invalid()
        sink.stdinCallback(event.callbackId ?? undefined, event.code)
        return
      case 'error':
      case 'stdoutError':
      case 'stderrError':
      case 'stdinError':
        if (typeof event.code !== 'string') return invalid()
        sink[event.kind](event.code)
        return
      default:
        sink[event.kind]()
    }
  }
  const backend = Object.freeze({
    descriptor: NATIVE_DARWIN_PROCESS_DESCRIPTOR_V1,
    normalizeConfiguration: normalizeNativeDarwinConfigurationV1,
    normalizeExecutable: normalizeNativeDarwinExecutableV1,
    validateProfile(profile) {
      if (
        profile.executables.length === 0 ||
        profile.environment.allowedScopes.length !== 1 ||
        profile.environment.defaultScope !== 'processTree' ||
        profile.environment.capabilityBridge.domains.length !== 0 ||
        profile.executables.some(item => !runtimeOwnsExecutable(profile.backend.configuration, item.executable.path))
      ) return invalid()
    },
    prepareLaunch(input) {
      if (
        input.generation !== generation || input.environmentScope !== 'processTree' ||
        input.policy?.access !== 'sandboxed' || input.policy.mounts.length !== 0 ||
        input.policy.network.access !== 'none' || input.policy.limits.maxWritableRootfsBytes !== 0 ||
        input.executable?.kind !== 'hostPath' ||
        !runtimeOwnsExecutable(input.configuration, input.executable.path) ||
        !input.executables.some(item =>
          item.executableId === input.executableId && item.executable.path === input.executable.path &&
          input.runtimeArgs.length >= item.fixedArgs.length &&
          item.fixedArgs.every((arg, index) => input.runtimeArgs[index] === arg)
        )
      ) return invalid()
      return Object.freeze({
        args: Object.freeze([...input.runtimeArgs]),
        executableId: input.executableId,
        generation,
        limits: input.policy.limits
      })
    },
    spawn(launch, options, sink) {
      assertOpen()
      if (options.generation !== generation) return invalid()
      const handle = command.spawn({
        generation,
        executableId: launch.executableId,
        args: launch.args,
        env: options.env,
        stdio: options.stdio,
        limits: options.limits,
        processResourceId: options.processResourceId
      })
      if (sinks.has(handle)) return invalid()
      sinks.set(handle, Object.freeze({ processResourceId: options.processResourceId, sink }))
      return Object.freeze({
        writeStdin(bytes, callbackId) {
          let accepted = true
          const chunks = Math.max(1, Math.ceil(bytes.byteLength / MAX_DARWIN_STDIN_CHUNK_BYTES_V1))
          for (let index = 0; index < chunks; index += 1) {
            const start = index * MAX_DARWIN_STDIN_CHUNK_BYTES_V1
            const chunk = bytes.subarray(start, start + MAX_DARWIN_STDIN_CHUNK_BYTES_V1)
            try {
              const queued = command.write(
                generation,
                handle,
                chunk,
                index === chunks - 1 ? callbackId : undefined
              )
              if (!queued) accepted = false
            } catch (error) {
              // A partial write may already be queued. Kill only this owned job
              // before the shared Provider reports the failed write.
              try {
                command.signal(generation, handle, 'SIGKILL')
              } catch {}
              throw error
            }
          }
          return accepted
        },
        endStdin: callbackId => command.end(generation, handle, callbackId),
        destroyStdio: index => command.destroy(generation, handle, index),
        signal: signal => {
          if (!SIGNALS.has(signal)) return invalid()
          command.signal(generation, handle, signal)
        }
      })
    },
    spawnSync(launch, options) {
      assertOpen()
      const processResourceId = `sync-${generation}-${nextSyncId++}`
      return command.spawnSync({
        generation,
        executableId: launch.executableId,
        args: launch.args,
        env: options.env,
        stdio: options.stdio,
        limits: launch.limits,
        processResourceId,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        encoding: options.encoding
      })
    },
    poll() {
      if (closed) return
      for (const event of command.poll(generation, 64)) dispatch(event)
    },
    closeGeneration(requestedGeneration) {
      if (requestedGeneration !== generation) return invalid()
      if (closed) return
      closed = true
      command.close(generation)
      sinks.clear()
    }
  })
  return backend
}

export const createNativeDarwinProcessRegistryV1 = backend => new NativeProcessBackendRegistryV1([backend])
