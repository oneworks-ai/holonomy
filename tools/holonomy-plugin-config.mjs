import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { TextDecoder } from 'node:util'

import { validateRuntimePluginConfig } from './runtime-plugin-config-validator.mjs'

const MAX_CONFIG_BYTES = 1024 * 1024
const ID = /^[A-Za-z0-9][\w.-]{0,127}$/u
const EXPORT = /^[$A-Z_a-z][$\w]*$/u
const SHA256 = /^[a-f\d]{64}$/u
const decoder = new TextDecoder('utf-8', { fatal: true })

const exact = (value, keys, label) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  if (Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`${label} contains an unknown field`)
  }
  return value
}

const readJson = (file, label) => {
  let descriptor
  try {
    const before = lstatSync(file)
    if (before.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
    if (!before.isFile()) throw new Error(`${label} is not a regular file`)
    if (before.size > MAX_CONFIG_BYTES) throw new Error(`${label} exceeds the size limit`)
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isFile()) throw new Error(`${label} is not a regular file`)
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} is unavailable`)
    }
    if (opened.size > MAX_CONFIG_BYTES) throw new Error(`${label} exceeds the size limit`)
    const bytes = new Uint8Array(MAX_CONFIG_BYTES + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset)
      if (count === 0) break
      offset += count
    }
    if (offset > MAX_CONFIG_BYTES) throw new Error(`${label} exceeds the size limit`)
    const after = fstatSync(descriptor)
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs || offset !== opened.size
    ) {
      throw new Error(`${label} is unavailable`)
    }
    let source
    try {
      source = decoder.decode(bytes.subarray(0, offset))
    } catch {
      throw new Error(`${label} is not valid UTF-8 JSON`)
    }
    try {
      return JSON.parse(source)
    } catch {
      throw new Error(`${label} is not valid JSON`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} `)) throw error
    throw new Error(`${label} is unavailable`)
  } finally {
    if (descriptor != null) {
      try {
        closeSync(descriptor)
      } catch {
        // Keep the selected read or admission error authoritative.
      }
    }
  }
}

// The Native reader supplies the bytes for managed launches. Keep JSON and
// plugin-shape validation here so the legacy synchronous path has one owner.
export const parseHoloPluginJson = (bytes, label, maximumBytes = MAX_CONFIG_BYTES) => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} exceeds the size limit`)
  }
  let source
  try {
    source = decoder.decode(bytes)
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`)
  }
  try {
    return JSON.parse(source)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

export const resolveHoloConfigPath = (input, options = {}) =>
  path.resolve(
    options.cwd ?? process.cwd(),
    input ?? 'holo.config.json'
  )

export const normalizeHoloPluginConfig = (source, configPath) => {
  const value = exact(source, ['plugins'], 'Holo config')
  const plugins = value.plugins ?? []
  if (!Array.isArray(plugins) || plugins.length > 128) {
    throw new Error('Holo config plugins must be a bounded array')
  }
  const ids = new Set()
  const normalized = plugins.map(item => {
    const entry = exact(
      item,
      ['config', 'enabled', 'export', 'id', 'integrity', 'use'],
      'Holo plugin entry'
    )
    if (typeof entry.id !== 'string' || !ID.test(entry.id) || ids.has(entry.id)) {
      throw new Error('Holo plugin id is invalid or duplicated')
    }
    if (typeof entry.use !== 'string' || entry.use.length === 0 || entry.use.length > 4096) {
      throw new Error('Holo plugin source is invalid')
    }
    if (entry.enabled != null && typeof entry.enabled !== 'boolean') {
      throw new Error('Holo plugin enabled must be a boolean')
    }
    const exportName = entry.export ?? 'default'
    if (typeof exportName !== 'string' || !EXPORT.test(exportName)) {
      throw new Error('Holo plugin export is invalid')
    }
    if (entry.integrity != null && (typeof entry.integrity !== 'string' || !SHA256.test(entry.integrity))) {
      throw new Error('Holo plugin integrity is invalid')
    }
    const config = structuredClone(entry.config ?? {})
    JSON.stringify(config)
    ids.add(entry.id)
    return Object.freeze({
      config,
      enabled: entry.enabled !== false,
      exportName,
      id: entry.id,
      integrity: entry.integrity,
      use: entry.use
    })
  })
  return Object.freeze({ configPath, plugins: Object.freeze(normalized) })
}

export const readHoloPluginConfig = (input, options = {}) => {
  const configPath = resolveHoloConfigPath(input, options)
  return normalizeHoloPluginConfig(readJson(configPath, 'Holo config'), configPath)
}

export const validateHoloPluginOptionsValue = (schema, value) => {
  validateRuntimePluginConfig(schema, value)
  return schema
}

export const validateHoloPluginOptions = (schemaFile, value) => {
  if (schemaFile == null) return
  const schema = readJson(schemaFile, 'Holo plugin config Schema')
  return validateHoloPluginOptionsValue(schema, value)
}
