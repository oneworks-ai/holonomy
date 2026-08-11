import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { serviceError } from './errors.mjs'
import { HARD_LOG_LIMITS, validatePersistedLogRecord } from './service-log-codec.mjs'
import { atomicWriteJson, readJsonFile, removeTemporaryFiles } from './state-files.mjs'
import { requireString } from './validation.mjs'

const LOG_FILE = /^[a-f0-9]{64}\.json$/u
const MAX_PROCESS_FILES = 4_096
const logFileName = processId => `${createHash('sha256').update(processId).digest('hex')}.json`
const corrupt = () => serviceError('service.state_corrupt', 'Holonomy Service process log state is unreadable')

const syncDirectory = async directory => {
  const descriptor = await open(directory, 'r')
  try {
    await descriptor.sync()
  } finally {
    await descriptor.close()
  }
}

export class ServiceLogPersistence {
  #directory
  #maxWriteBytes

  constructor(options) {
    this.#directory = requireString(options.directory, 'Process log directory', { max: 4_096 })
    this.#maxWriteBytes = options.limits.maxProcessBytes + 64 * 1024
  }

  async load() {
    await mkdir(this.#directory, { mode: 0o700, recursive: true })
    await chmod(this.#directory, 0o700)
    await removeTemporaryFiles([this.#directory])
    const entries = (await readdir(this.#directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && LOG_FILE.test(entry.name))
    if (entries.length > MAX_PROCESS_FILES) throw corrupt()
    const records = new Map()
    let totalBytes = 0
    let totalEntries = 0
    for (const entry of entries) {
      const path = join(this.#directory, entry.name)
      if ((await stat(path)).size > HARD_LOG_LIMITS.maxProcessBytes + 64 * 1024) throw corrupt()
      const record = validatePersistedLogRecord(await readJsonFile(path))
      if (entry.name !== logFileName(record.processId) || records.has(record.processId)) throw corrupt()
      totalBytes += record.totalBytes
      totalEntries += record.events.length
      if (totalBytes > HARD_LOG_LIMITS.maxTotalBytes || totalEntries > HARD_LOG_LIMITS.maxTotalEntries) {
        throw corrupt()
      }
      records.set(record.processId, record)
    }
    return records
  }

  async writeChanged(previous, next, changed, appendProcessId) {
    const ids = [...changed].sort((left, right) => {
      if (left === appendProcessId) return 1
      if (right === appendProcessId) return -1
      const leftDelta = (next.get(left)?.totalBytes ?? 0) - (previous.get(left)?.totalBytes ?? 0)
      const rightDelta = (next.get(right)?.totalBytes ?? 0) - (previous.get(right)?.totalBytes ?? 0)
      return leftDelta - rightDelta || left.localeCompare(right)
    })
    for (const processId of ids) {
      const record = next.get(processId)
      if (record != null) {
        await atomicWriteJson(join(this.#directory, logFileName(processId)), record, this.#maxWriteBytes)
      }
    }
  }

  async remove(processId) {
    try {
      await unlink(join(this.#directory, logFileName(processId)))
      await syncDirectory(this.#directory)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}
