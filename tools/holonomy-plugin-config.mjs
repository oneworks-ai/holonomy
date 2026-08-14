import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import Ajv2020 from 'ajv/dist/2020.js'

const MAX_CONFIG_BYTES = 1024 * 1024
const ID = /^[A-Za-z0-9][\w.-]{0,127}$/u
const EXPORT = /^[$A-Z_a-z][$\w]*$/u
const SHA256 = /^[a-f\d]{64}$/u

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
  const source = readFileSync(file)
  if (source.byteLength > MAX_CONFIG_BYTES) throw new Error(`${label} exceeds the size limit`)
  try {
    return JSON.parse(source.toString('utf8'))
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

export const resolveHoloConfigPath = (input, options = {}) =>
  path.resolve(
    options.cwd ?? process.cwd(),
    input ?? 'holo.config.json'
  )

export const readHoloPluginConfig = (input, options = {}) => {
  const configPath = resolveHoloConfigPath(input, options)
  const value = exact(readJson(configPath, 'Holo config'), ['plugins'], 'Holo config')
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

export const validateHoloPluginOptions = (schemaFile, value) => {
  if (schemaFile == null) return
  const schema = readJson(schemaFile, 'Holo plugin config Schema')
  const validator = new Ajv2020({ allErrors: false, strict: true, validateFormats: false }).compile(schema)
  if (!validator(value)) throw new Error('Holo plugin config does not match its Schema')
}
