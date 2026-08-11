import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { chmod, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'

import { SERVICE_SCHEMA_VERSION } from './constants.mjs'
import { serviceError } from './errors.mjs'
import { canonicalJson, cloneJson, requireInteger, requireRecord, requireString } from './validation.mjs'

const JOURNAL_FILE = /^\d{16}\.json$/u
const byteLength = value => Buffer.byteLength(value, 'utf8')

export const readJsonFile = async path => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw serviceError('service.state_corrupt', 'Holonomy Service state is unreadable')
  }
}

const syncDirectory = async directory => {
  const descriptor = await open(directory, 'r')
  try {
    await descriptor.sync()
  } finally {
    await descriptor.close()
  }
}

export const atomicWriteJson = async (path, value, maxBytes) => {
  const encoded = `${canonicalJson(value)}\n`
  if (byteLength(encoded) > maxBytes) {
    throw serviceError('service.limit_exceeded', 'Holonomy Service persisted state exceeds its limit')
  }
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  const descriptor = await open(temporary, 'wx', 0o600)
  try {
    await descriptor.writeFile(encoded, 'utf8')
    await descriptor.sync()
  } finally {
    await descriptor.close()
  }
  await rename(temporary, path)
  await chmod(path, 0o600)
  await syncDirectory(directory)
}

export const journalName = cursor => `${String(cursor).padStart(16, '0')}.json`

export const validateState = value => {
  const state = requireRecord(value, 'Persisted state')
  if (state.schemaVersion !== SERVICE_SCHEMA_VERSION) {
    throw serviceError('service.state_corrupt', 'Holonomy Service state schema is unsupported')
  }
  requireInteger(state.cursor, 'Persisted state cursor', { min: 0 })
  requireInteger(state.eventFloor, 'Persisted event floor', { min: 0, max: state.cursor })
  requireRecord(state.idempotency, 'Persisted idempotency state')
  const resources = requireRecord(state.resources, 'Persisted resources')
  for (const name of ['devices', 'inspectors', 'networkRules', 'operations', 'processes']) {
    requireRecord(resources[name], `Persisted ${name}`)
  }
  return cloneJson(state)
}

const validateJournal = value => {
  const record = requireRecord(value, 'Journal record')
  if (record.schemaVersion !== SERVICE_SCHEMA_VERSION) {
    throw serviceError('service.state_corrupt', 'Holonomy Service journal schema is unsupported')
  }
  requireInteger(record.cursor, 'Journal cursor', { min: 1 })
  requireInteger(record.at, 'Journal timestamp', { min: 0 })
  const event = requireRecord(record.event, 'Journal event')
  requireString(event.type, 'Journal event type', { max: 128 })
  const nextState = validateState(record.nextState)
  if (nextState.cursor !== record.cursor || event.cursor !== record.cursor || event.at !== record.at) {
    throw serviceError('service.state_corrupt', 'Holonomy Service journal identity is invalid')
  }
  return { ...record, event: cloneJson(event), nextState }
}

export const readJournalRecords = async directory => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = entries.filter(entry => entry.isFile() && JOURNAL_FILE.test(entry.name)).map(entry => entry.name).sort()
  const records = []
  for (const file of files) {
    const record = validateJournal(await readJsonFile(join(directory, file)))
    if (journalName(record.cursor) !== file) {
      throw serviceError('service.state_corrupt', 'Holonomy Service journal filename is invalid')
    }
    records.push(record)
  }
  return records
}

export const removeTemporaryFiles = async directories => {
  for (const directory of directories) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith('.') && entry.name.endsWith('.tmp')) {
        await rm(join(directory, entry.name), { force: true })
      }
    }
  }
}
