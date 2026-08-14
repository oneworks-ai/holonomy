import path from 'node:path'

import { createNodeEnvironmentProcessBackendV1 } from './capability-process-environment-backend.mjs'
import { createV86ProcessEnvironmentFactoryV1 } from './capability-process-v86-environment.mjs'

const invalid = () => {
  throw new TypeError('Invalid v86 Process Backend configuration')
}

const exact = (value, keys) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid()
  return value
}

const artifact = value => {
  const input = exact(value, ['artifactId', 'sha256'])
  if (
    typeof input.artifactId !== 'string' || !/^[A-Za-z0-9][\w.-]{0,127}$/u.test(input.artifactId) ||
    typeof input.sha256 !== 'string' || !/^[a-f\d]{64}$/u.test(input.sha256)
  ) return invalid()
  return Object.freeze({ artifactId: input.artifactId, sha256: input.sha256 })
}

const optionalArtifact = value => value == null ? undefined : artifact(value)
const KERNEL_CAPABILITIES = Object.freeze([
  'process',
  'fuse',
  'tun',
  'networkNamespaces',
  'cgroups',
  'fanotify',
  'seccompUserNotification'
])

const kernelCapabilities = value => {
  if (
    !Array.isArray(value) || value.length === 0 || value.length > KERNEL_CAPABILITIES.length ||
    new Set(value).size !== value.length || value.some(item => !KERNEL_CAPABILITIES.includes(item)) ||
    !value.includes('process')
  ) return invalid()
  return Object.freeze(
    [...value].sort((left, right) => KERNEL_CAPABILITIES.indexOf(left) - KERNEL_CAPABILITIES.indexOf(right))
  )
}

const normalizeConfiguration = value => {
  const input = exact(value, ['artifacts', 'memoryBytes', 'requiredKernelCapabilities', 'supervisor'])
  const artifacts = exact(input.artifacts, ['bios', 'initialState', 'initrd', 'kernel', 'wasm'])
  const supervisor = exact(input.supervisor, ['protocolVersion'])
  if (
    !Number.isInteger(input.memoryBytes) || input.memoryBytes < 32 * 1024 * 1024 ||
    input.memoryBytes > 512 * 1024 * 1024 || (input.memoryBytes & (input.memoryBytes - 1)) !== 0 ||
    supervisor.protocolVersion !== 1
  ) return invalid()
  const initialState = optionalArtifact(artifacts.initialState)
  return Object.freeze({
    artifacts: Object.freeze({
      bios: artifact(artifacts.bios),
      ...(initialState == null ? {} : { initialState }),
      initrd: artifact(artifacts.initrd),
      kernel: artifact(artifacts.kernel),
      wasm: artifact(artifacts.wasm)
    }),
    memoryBytes: input.memoryBytes,
    requiredKernelCapabilities: kernelCapabilities(input.requiredKernelCapabilities),
    supervisor: Object.freeze({ protocolVersion: 1 })
  })
}

const normalizeExecutable = value => {
  const input = exact(value, ['kind', 'path'])
  if (
    input.kind !== 'guestPath' || typeof input.path !== 'string' || input.path.length > 4096 ||
    input.path.includes('\0') || !input.path.startsWith('/') || path.posix.normalize(input.path) !== input.path ||
    input.path === '/' || input.path.endsWith('/')
  ) return invalid()
  return Object.freeze({ kind: 'guestPath', path: input.path })
}

export const V86_PROCESS_BACKEND_DESCRIPTOR_V1 = Object.freeze({
  backendId: 'experimental.v86-v1',
  binaryFormats: Object.freeze(['linux-x86-32']),
  environmentScopes: Object.freeze(['processTree', 'runtime']),
  family: 'virtual-machine',
  features: Object.freeze({
    filesystemBridge: false,
    networkBridge: false,
    pty: false,
    shell: true,
    signals: true,
    snapshots: true,
    synchronousSpawn: false
  }),
  platforms: Object.freeze(['android', 'desktop', 'node']),
  stability: 'experimental',
  version: 1
})

export const createV86ProcessBackendV1 = options => {
  const environmentFactory = options?.environmentFactory ?? createV86ProcessEnvironmentFactoryV1(options)
  const bridged = options?.handleFilesystemRequest != null || options?.handleNetworkRequest != null
  const descriptor = !bridged
    ? V86_PROCESS_BACKEND_DESCRIPTOR_V1
    : Object.freeze({
      ...V86_PROCESS_BACKEND_DESCRIPTOR_V1,
      features: Object.freeze({
        ...V86_PROCESS_BACKEND_DESCRIPTOR_V1.features,
        filesystemBridge: options?.handleFilesystemRequest != null,
        networkBridge: options?.handleNetworkRequest != null
      })
    })
  const backend = createNodeEnvironmentProcessBackendV1({
    defaultCwd: '/',
    descriptor,
    environmentFactory,
    normalizeConfiguration,
    normalizeExecutable,
    validateProfile(profile) {
      if (profile.executables.some(item => item.executable.kind !== 'guestPath')) return invalid()
    }
  })
  return backend
}
