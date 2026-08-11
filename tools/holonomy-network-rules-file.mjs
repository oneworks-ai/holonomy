import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import process from 'node:process'

const MAX_RULE_FILE_BYTES = 1024 * 1024

const unavailable = () => new Error('Network rules file is unavailable')

export const readHolonomyNetworkRules = (input, options = {}) => {
  if (typeof input !== 'string' || input === '' || extname(input).toLowerCase() !== '.json') {
    throw new Error('--network-rules must reference one JSON file')
  }
  const path = resolve(options.cwd ?? process.cwd(), input)
  let descriptor
  try {
    const before = lstatSync(path)
    if (before.isSymbolicLink()) throw new Error('Network rules file must not be a symbolic link')
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isFile()) throw new Error('Network rules path is not a file')
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw unavailable()
    if (opened.size > MAX_RULE_FILE_BYTES) throw new Error('Network rules file exceeds the size limit')
    const buffer = new Uint8Array(MAX_RULE_FILE_BYTES + 1)
    let offset = 0
    while (offset <= MAX_RULE_FILE_BYTES) {
      const count = readSync(descriptor, buffer, offset, buffer.byteLength - offset)
      if (count === 0) break
      offset += count
    }
    if (offset > MAX_RULE_FILE_BYTES) throw new Error('Network rules file exceeds the size limit')
    let value
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)))
    } catch {
      throw new Error('Network rules file is not valid UTF-8 JSON')
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Network rules file must contain one rule set object')
    }
    return value
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Network rules ')) throw error
    throw unavailable()
  } finally {
    if (descriptor != null) {
      try {
        closeSync(descriptor)
      } catch {
        // The authoritative read result is already known.
      }
    }
  }
}
