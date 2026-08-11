import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'

import { serviceError } from './errors.mjs'
import { createServiceToken } from './http-utils.mjs'
import { readBoundedRegularFile } from './secure-file-read.mjs'
import { atomicWriteJson, readJsonFile } from './state-files.mjs'

export const resolveHolonomyHome = (environment = process.env) => {
  const input = environment.HOLONOMY_HOME ?? join(homedir(), '.holonomy')
  if (!isAbsolute(input)) throw serviceError('service.invalid_request', 'HOLONOMY_HOME must be absolute')
  return input
}

export const serviceHomePaths = home =>
  Object.freeze({
    endpoint: join(home, 'endpoint.json'),
    home,
    journal: join(home, 'journal'),
    lock: join(home, 'service.lock'),
    state: join(home, 'state'),
    token: join(home, 'token')
  })

export const prepareServiceHome = async home => {
  const paths = serviceHomePaths(home)
  for (const directory of [paths.home, paths.journal, paths.state]) {
    await mkdir(directory, { mode: 0o700, recursive: true })
    await chmod(directory, 0o700)
  }
  return paths
}

export const readServiceToken = async path => {
  try {
    const token = (await readBoundedRegularFile(path, {
      label: 'Holonomy Service token file',
      maxBytes: 4096,
      ownerOnly: true
    })).toString('utf8').trim()
    if (token.length < 32 || /\s/u.test(token)) throw new TypeError('invalid token')
    return token
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw serviceError('service.state_corrupt', 'Holonomy Service token file is invalid')
  }
}

export const ensureServiceToken = async path => {
  const existing = await readServiceToken(path)
  if (existing != null) {
    await chmod(path, 0o600)
    return existing
  }
  const token = createServiceToken()
  await writePrivateText(path, `${token}\n`)
  return token
}

export const writeServiceEndpoint = async (path, endpoint) => {
  await atomicWriteJson(path, endpoint, 16 * 1024)
}

export const readServiceEndpoint = async path => {
  const endpoint = await readJsonFile(path)
  if (endpoint == null) return undefined
  if (typeof endpoint.baseUrl !== 'string' || !Number.isSafeInteger(endpoint.pid)) {
    throw serviceError('service.state_corrupt', 'Holonomy Service endpoint file is invalid')
  }
  const url = new URL(endpoint.baseUrl)
  if (!['127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    throw serviceError('service.state_corrupt', 'Holonomy Service endpoint is not loopback')
  }
  return endpoint
}

export const acquireServiceLock = async path => {
  let descriptor
  try {
    descriptor = await open(path, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') return undefined
    throw error
  }
  await descriptor.writeFile(`${JSON.stringify({ createdAt: Date.now(), pid: process.pid })}\n`)
  await descriptor.sync()
  await chmod(path, 0o600)
  let released = false
  return Object.freeze({
    async release() {
      if (released) return
      released = true
      await descriptor.close()
      await unlink(path).catch(error => {
        if (error?.code !== 'ENOENT') throw error
      })
    }
  })
}

export const readServiceLock = async path => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw serviceError('service.state_corrupt', 'Holonomy Service lock file is invalid')
  }
}

export const removeServiceEndpoint = async path =>
  await unlink(path).catch(error => {
    if (error?.code !== 'ENOENT') throw error
  })

export const removeStaleServiceLock = async path =>
  await unlink(path).catch(error => {
    if (error?.code !== 'ENOENT') throw error
  })

export async function writePrivateText(path, text) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  const descriptor = await open(temporary, 'wx', 0o600)
  try {
    await descriptor.writeFile(text, 'utf8')
    await descriptor.sync()
  } finally {
    await descriptor.close()
  }
  await rename(temporary, path)
  await chmod(path, 0o600)
}
