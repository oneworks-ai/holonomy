import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'

import { serviceError } from './errors.mjs'
import { normalizeNativeDiagnosticAuditInstallation } from './native-diagnostic-audit-installation.mjs'
import { normalizeNativeDiagnosticSourceReaderInstallation } from './native-diagnostic-source-reader-installation.mjs'
import { readBoundedRegularFile } from './secure-file-read.mjs'

export const validateNativeExecutable = async path => {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4_096) {
    throw serviceError('service.invalid_request', 'Native executable installation is invalid')
  }
  let metadata
  try {
    metadata = await lstat(path)
    if (
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.mode & 0o022 ||
      !(metadata.mode & 0o100) || metadata.uid !== process.getuid?.() ||
      await realpath(path) !== path
    ) throw new Error('invalid')
    for (let directory = dirname(path);;) {
      const ancestor = await lstat(directory)
      if (
        !ancestor.isDirectory() || ancestor.isSymbolicLink() ||
        ancestor.uid !== 0 && ancestor.uid !== process.getuid?.() ||
        (ancestor.mode & 0o022) !== 0 && (ancestor.mode & 0o1000) === 0
      ) throw new Error('untrusted ancestor')
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  } catch {
    throw serviceError('service.unavailable', 'Owner-selected Native executable is unavailable')
  }
  return path
}

export const readServiceNativeRuntimeInstallationDetails = async home => {
  const path = join(home, 'native-runtime.json')
  let bytes
  try {
    bytes = await readBoundedRegularFile(path, {
      label: 'Native Runtime installation',
      maxBytes: 16 * 1024,
      ownerOnly: true
    })
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    if (error?.code === 'service.state_corrupt') throw error
    throw serviceError('service.state_corrupt', 'Native Runtime installation is invalid')
  }
  let installation
  try {
    installation = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw serviceError('service.state_corrupt', 'Native Runtime installation is invalid')
  }
  const allowed = new Set([
    'schemaVersion',
    'executablePath',
    'deviceProvider',
    'diagnosticSourceReader',
    'diagnosticAudit'
  ])
  if (
    installation == null || typeof installation !== 'object' || Array.isArray(installation) ||
    installation?.schemaVersion !== 1 ||
    !Object.hasOwn(installation, 'schemaVersion') ||
    !Object.hasOwn(installation, 'executablePath') ||
    Object.keys(installation).some(key => !allowed.has(key))
  ) throw serviceError('service.state_corrupt', 'Native Runtime installation is invalid')
  const deviceProvider = installation.deviceProvider
  if (
    Object.hasOwn(installation, 'deviceProvider') && (
      deviceProvider == null ||
      typeof deviceProvider !== 'object' || Array.isArray(deviceProvider) ||
      Object.keys(deviceProvider).join(',') !== 'implementation' ||
      deviceProvider.implementation !== 'builtin.darwin-device-v1' ||
      process.platform !== 'darwin' || process.arch !== 'arm64'
    )
  ) throw serviceError('service.state_corrupt', 'Native Device installation is invalid')
  let diagnosticSourceReader
  try {
    diagnosticSourceReader = normalizeNativeDiagnosticSourceReaderInstallation(installation.diagnosticSourceReader)
  } catch {
    throw serviceError('service.state_corrupt', 'Native diagnostic source reader installation is invalid')
  }
  let diagnosticAudit
  try {
    diagnosticAudit = normalizeNativeDiagnosticAuditInstallation(installation.diagnosticAudit)
    if (Object.hasOwn(installation, 'diagnosticAudit') && diagnosticAudit == null) {
      throw new TypeError('Native diagnostic audit installation is invalid')
    }
  } catch {
    throw serviceError('service.state_corrupt', 'Native diagnostic audit installation is invalid')
  }
  return Object.freeze({
    executablePath: await validateNativeExecutable(installation.executablePath),
    ...(deviceProvider == null ? {} : { deviceProvider: Object.freeze({ ...deviceProvider }) }),
    ...(diagnosticSourceReader == null
      ? {}
      : { diagnosticSourceReader }),
    ...(diagnosticAudit == null ? {} : { diagnosticAudit })
  })
}

export const readServiceNativeRuntimeInstallation = async home =>
  (await readServiceNativeRuntimeInstallationDetails(home))?.executablePath
