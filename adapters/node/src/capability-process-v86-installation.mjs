import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import process from 'node:process'

import { NODE_PROCESS_BACKEND_REGISTRY_V1 } from './capability-process-backend.mjs'
import { createV86ProcessBackendV1 } from './capability-process-v86-backend.mjs'
import { NodeV86FilesystemBrokerV1 } from './capability-process-v86-filesystem-broker.mjs'
import { V86FuseBridgeV1 } from './capability-process-v86-fuse.mjs'
import { NodeV86ProcessNetworkBrokerV1 } from './capability-process-v86-network-broker.mjs'

const BACKEND_ID = 'experimental.v86-v1'
const IMPLEMENTATION = 'builtin.v86-v1'
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024
const ARTIFACT_ID = /^[A-Za-z0-9][\w.-]{0,127}$/u

const invalid = () => {
  throw new TypeError('Invalid Node Process Backend installation')
}

const exact = (value, keys) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid()
  return value
}

export const normalizeNodeProcessBackendInstallationV1 = value => {
  const input = exact(value, ['artifactRoot', 'backendId', 'implementation'])
  if (
    input.backendId !== BACKEND_ID || input.implementation !== IMPLEMENTATION ||
    typeof input.artifactRoot !== 'string' || input.artifactRoot.length > 4096 ||
    input.artifactRoot.includes('\0') || !isAbsolute(input.artifactRoot) ||
    normalize(input.artifactRoot) !== input.artifactRoot
  ) return invalid()
  return Object.freeze({
    artifactRoot: input.artifactRoot,
    backendId: BACKEND_ID,
    implementation: IMPLEMENTATION
  })
}

const readArtifact = async (installation, artifact) => {
  if (
    artifact == null || typeof artifact !== 'object' ||
    !ARTIFACT_ID.test(artifact.artifactId)
  ) return invalid()
  const path = join(installation.artifactRoot, artifact.artifactId)
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = await descriptor.stat()
    if (
      !stats.isFile() || stats.size <= 0 || stats.size > MAX_ARTIFACT_BYTES ||
      (typeof process.getuid === 'function' && stats.uid !== process.getuid()) ||
      (stats.mode & 0o022) !== 0
    ) return invalid()
    return new Uint8Array(await descriptor.readFile())
  } finally {
    await descriptor.close()
  }
}

const loadV86 = async () => {
  let namespace
  try {
    namespace = await import('v86')
  } catch {
    return invalid()
  }
  if (typeof namespace.V86 !== 'function') return invalid()
  return namespace.V86
}

export const createInstalledV86ProcessBackendRuntimeV1 = value => {
  const installation = normalizeNodeProcessBackendInstallationV1(value)
  const filesystem = new NodeV86FilesystemBrokerV1()
  const fuse = new V86FuseBridgeV1(input => filesystem.dispatch(input))
  const network = new NodeV86ProcessNetworkBrokerV1()
  const backend = createV86ProcessBackendV1({
    handleFilesystemRequest: input => fuse.handle(input),
    handleNetworkRequest: input => network.fetch(input),
    loadArtifact: artifact => readArtifact(installation, artifact),
    loadV86
  })
  let bound = false
  return Object.freeze({
    backend,
    bind(invoke) {
      if (bound || typeof invoke !== 'function') return invalid()
      bound = true
      filesystem.bind(invoke)
      network.bind(invoke)
    },
    installation,
    registry: NODE_PROCESS_BACKEND_REGISTRY_V1.extend([backend])
  })
}

export const createNodeProcessBackendRegistryForInstallationV1 = value =>
  createInstalledV86ProcessBackendRuntimeV1(value).registry

export const verifyInstalledV86ProcessProfileV1 = async (profile, value) => {
  const installation = normalizeNodeProcessBackendInstallationV1(value)
  if (profile?.backend?.backendId !== BACKEND_ID) return invalid()
  for (const artifact of Object.values(profile.backend.configuration.artifacts)) {
    const bytes = await readArtifact(installation, artifact)
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) return invalid()
  }
  await loadV86()
}
