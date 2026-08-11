import { Buffer } from 'node:buffer'

export const HOLONOMY_SESSION_LIMITS = Object.freeze({
  maxArgBytes: 16 * 1024,
  maxArgs: 256,
  maxArgsBytes: 256 * 1024,
  maxEnvEntries: 256,
  maxEnvKeyBytes: 256,
  maxEnvValueBytes: 64 * 1024,
  maxEnvBytes: 1024 * 1024,
  maxModuleBytes: 8 * 1024 * 1024,
  maxModuleCount: 512,
  maxModulesBytes: 48 * 1024 * 1024,
  maxRequestBytes: 64 * 1024 * 1024,
  maxSocketNameBytes: 128,
  maxUrlBytes: 4 * 1024
})

const bytes = value => Buffer.byteLength(value, 'utf8')

const requireString = (value, label, maxBytes) => {
  if (typeof value !== 'string' || bytes(value) > maxBytes) throw new Error(`${label} exceeds the session limit`)
  return bytes(value)
}

const requireAbsoluteUrl = (value, label) => {
  requireString(value, label, HOLONOMY_SESSION_LIMITS.maxUrlBytes)
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be an absolute URL`)
  }
  if (!parsed.protocol) throw new Error(`${label} must be an absolute URL`)
}

export const encodeHolonomySession = payload => {
  if (payload == null || payload.schemaVersion !== 1) throw new Error('Unsupported runtime session schema')
  requireAbsoluteUrl(payload.entryUrl, 'Runtime entry URL')
  if (
    !Array.isArray(payload.modules) || payload.modules.length < 1 ||
    payload.modules.length > HOLONOMY_SESSION_LIMITS.maxModuleCount
  ) {
    throw new Error('Invalid runtime module count')
  }
  let moduleBytes = 0
  for (const module of payload.modules) {
    requireAbsoluteUrl(module?.url, 'Runtime module URL')
    const sourceBytes = requireString(module?.source, 'Runtime module source', HOLONOMY_SESSION_LIMITS.maxModuleBytes)
    moduleBytes += sourceBytes
    if (moduleBytes > HOLONOMY_SESSION_LIMITS.maxModulesBytes) {
      throw new Error('Runtime module graph exceeds the session limit')
    }
  }
  if (!Array.isArray(payload.argv) || payload.argv.length > HOLONOMY_SESSION_LIMITS.maxArgs) {
    throw new Error('Runtime argv exceeds the session limit')
  }
  let argvBytes = 0
  for (const argument of payload.argv) {
    argvBytes += requireString(argument, 'Runtime argument', HOLONOMY_SESSION_LIMITS.maxArgBytes)
    if (argvBytes > HOLONOMY_SESSION_LIMITS.maxArgsBytes) throw new Error('Runtime argv exceeds the session limit')
  }
  const envEntries = Object.entries(payload.env ?? {})
  if (envEntries.length > HOLONOMY_SESSION_LIMITS.maxEnvEntries) {
    throw new Error('Runtime env exceeds the session limit')
  }
  let envBytes = 0
  for (const [key, value] of envEntries) {
    envBytes += requireString(key, 'Runtime env key', HOLONOMY_SESSION_LIMITS.maxEnvKeyBytes)
    envBytes += requireString(value, 'Runtime env value', HOLONOMY_SESSION_LIMITS.maxEnvValueBytes)
    if (envBytes > HOLONOMY_SESSION_LIMITS.maxEnvBytes) throw new Error('Runtime env exceeds the session limit')
  }
  if (payload.inspector != null) {
    requireString(payload.inspector.socketName, 'Inspector socket name', HOLONOMY_SESSION_LIMITS.maxSocketNameBytes)
  }
  const encoded = JSON.stringify(payload)
  if (bytes(encoded) > HOLONOMY_SESSION_LIMITS.maxRequestBytes) {
    throw new Error('Runtime session exceeds the request limit')
  }
  return encoded
}
