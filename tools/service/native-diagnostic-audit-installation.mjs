import { isProxy } from 'node:util/types'

const INVALID_INSTALLATION = 'Native diagnostic audit installation is invalid'

export const normalizeNativeDiagnosticAuditInstallation = value => {
  if (value === undefined) return undefined
  try {
    if (value == null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
      throw new TypeError(INVALID_INSTALLATION)
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(INVALID_INSTALLATION)
    }
    const keys = Reflect.ownKeys(value)
    if (keys.length !== 1 || keys[0] !== 'maxBytes') {
      throw new TypeError(INVALID_INSTALLATION)
    }
    const bytes = Object.getOwnPropertyDescriptor(value, 'maxBytes')
    if (
      !bytes?.enumerable || !Object.hasOwn(bytes, 'value') ||
      !Number.isSafeInteger(bytes.value) || bytes.value < 1_024 || bytes.value > 16_777_216
    ) throw new TypeError(INVALID_INSTALLATION)
    return Object.freeze({ maxBytes: bytes.value })
  } catch {
    throw new TypeError(INVALID_INSTALLATION)
  }
}

export const selectNativeDiagnosticAuditForPolicy = (policy, installation, sourceReader) => {
  if (policy?.diagnostics?.sourceReader !== 'boundedSource' || sourceReader == null) return undefined
  return normalizeNativeDiagnosticAuditInstallation(installation)
}
