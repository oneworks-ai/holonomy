import { serviceError } from './errors.mjs'

const INVALID_INSTALLATION = 'Native diagnostic source reader installation is invalid'
const CAPABILITY_NAME = 'host.diagnostics.source.read'

export const normalizeNativeDiagnosticSourceReaderInstallation = value => {
  if (value === undefined) return undefined
  try {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(INVALID_INSTALLATION)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(INVALID_INSTALLATION)
    }
    const keys = Reflect.ownKeys(value)
    if (
      keys.length !== 3 ||
      !keys.includes('capabilityName') || !keys.includes('maxReadBytes') || !keys.includes('maxReads')
    ) throw new TypeError(INVALID_INSTALLATION)
    const name = Object.getOwnPropertyDescriptor(value, 'capabilityName')
    const bytes = Object.getOwnPropertyDescriptor(value, 'maxReadBytes')
    const reads = Object.getOwnPropertyDescriptor(value, 'maxReads')
    if (
      !name?.enumerable || !bytes?.enumerable || !reads?.enumerable ||
      !Object.hasOwn(name, 'value') || !Object.hasOwn(bytes, 'value') ||
      !Object.hasOwn(reads, 'value') ||
      name.value !== CAPABILITY_NAME ||
      !Number.isSafeInteger(bytes.value) || bytes.value < 1 || bytes.value > 1024 * 1024 ||
      !Number.isSafeInteger(reads.value) || reads.value < 1 || reads.value > 1024
    ) throw new TypeError(INVALID_INSTALLATION)
    return Object.freeze({
      capabilityName: CAPABILITY_NAME,
      maxReadBytes: bytes.value,
      maxReads: reads.value
    })
  } catch {
    throw new TypeError(INVALID_INSTALLATION)
  }
}

export const selectNativeDiagnosticSourceReaderForPolicy = (policy, installation) => {
  if (policy.diagnostics.sourceReader !== 'boundedSource') return undefined
  let selected
  try {
    selected = normalizeNativeDiagnosticSourceReaderInstallation(installation)
  } catch {
    // Only an exact owner-private installation can satisfy boundedSource.
  }
  if (selected == null || policy.diagnostics.maxSourceReadBytes < 1) {
    throw serviceError('sandbox.capability_unsupported', 'Native diagnostic source reader is unavailable')
  }
  return selected
}
