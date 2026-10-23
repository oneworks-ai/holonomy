/* eslint-disable max-lines -- The bounded JSONL state machine owns its child and framing together. */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { TextDecoder } from 'node:util'

const MAX_LINE_BYTES = 12 * 1024 * 1024
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_QUEUE = 128
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_PACKAGE_LEASES = 128
const HEX_SHA256 = /^[a-f0-9]{64}$/u
const NATIVE_ERROR_CODES = new Set([
  'invalid_request',
  'invalid_state',
  'invalid_path',
  'source_unavailable',
  'source_rejected',
  'source_limit',
  'source_changed',
  'invalid_utf8',
  'frame_too_large'
])
const UTF8 = new TextDecoder('utf-8', { fatal: true })

const failure = code => Object.assign(new Error(`Native source reader failed: ${code}`), { code })
const ownKeys = (value, keys) =>
  value != null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key))

const absolutePath = value => {
  if (
    typeof value !== 'string' || value.length === 0 || value.includes('\0') ||
    Buffer.byteLength(value) > 4096 || !path.isAbsolute(value) || path.resolve(value) !== value
  ) {
    throw failure('invalid_request')
  }
  return value
}

const within = (root, target) =>
  target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)

const packageRelativePath = value => {
  if (
    typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4096 ||
    value.includes('\\') || value.includes('\0') ||
    value.split('/').some(segment =>
      segment === '' || segment === '.' || segment === '..' || segment !== segment.normalize('NFC')
    )
  ) throw failure('invalid_request')
  return value
}

const packageId = value => {
  if (
    typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 128 ||
    ![...value].every(character => {
      const code = character.codePointAt(0)
      return code >= 33 && code <= 126
    })
  ) throw failure('invalid_response')
  return value
}

const readPurpose = value => {
  if (value === undefined) return undefined
  if (value === 'module' || value === 'packageMetadata') return value
  throw failure('invalid_request')
}

const exactPackageMetadataUrl = value => {
  const url = new URL(value)
  return !value.includes('?') && !value.includes('#') &&
    decodeURIComponent(url.pathname.split('/').at(-1)) === 'package.json'
}

const canonicalGuestUrl = value => {
  if (typeof value !== 'string' || value.length > 4096) throw failure('invalid_request')
  let url
  try {
    url = new URL(value)
  } catch {
    throw failure('invalid_request')
  }
  if (
    url.href !== value || url.protocol !== 'app:' || url.hostname !== 'workspace' ||
    url.username || url.password || url.port || url.hash || !url.pathname.startsWith('/')
  ) {
    throw failure('invalid_request')
  }
  return value
}

const canonicalResourceUrl = value => {
  const selected = canonicalGuestUrl(value)
  if (!selected.startsWith('app://workspace/')) throw failure('invalid_response')
  const url = new URL(selected)
  const segments = url.pathname.slice(1).split('/')
  if (
    segments.some(segment => {
      let decoded
      try {
        decoded = decodeURIComponent(segment)
      } catch {
        return true
      }
      return decoded === '' || decoded === '.' || decoded === '..' ||
        decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0') ||
        decoded !== decoded.normalize('NFC')
    })
  ) throw failure('invalid_response')
  const canonical = new URL('app://workspace/')
  canonical.pathname = `/${segments.map(segment => decodeURIComponent(segment).replaceAll('%', '%25')).join('/')}`
  if (canonical.pathname !== url.pathname) throw failure('invalid_response')
  return selected
}

const canonicalPrivateRootUrl = value => {
  if (typeof value !== 'string' || value.length > 256) throw failure('invalid_request')
  let url
  try {
    url = new URL(value)
  } catch {
    throw failure('invalid_request')
  }
  const id = value.startsWith('holo-plugins:///')
    ? value.slice('holo-plugins:///'.length, -1)
    : ''
  if (
    !value.endsWith('/') || !/^[A-Za-z0-9][\w.-]*$/u.test(id) ||
    url.href !== value || url.protocol !== 'holo-plugins:' ||
    url.hostname || url.username || url.password || url.port ||
    url.search || url.hash || url.pathname !== `/${id}/`
  ) throw failure('invalid_request')
  return value
}

const canonicalPrivateResourceUrl = (value, rootUrl) => {
  if (typeof value !== 'string' || value.length > 4_096 || !value.startsWith(rootUrl)) {
    throw failure('invalid_request')
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw failure('invalid_request')
  }
  const tail = value.slice(rootUrl.length)
  const segments = tail.split('/')
  if (
    tail === '' || url.href !== value || url.search || url.hash ||
    segments.some(segment => {
      let decoded
      try {
        decoded = decodeURIComponent(segment)
      } catch {
        return true
      }
      return decoded === '' || decoded === '.' || decoded === '..' ||
        decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0') ||
        decoded !== decoded.normalize('NFC')
    })
  ) throw failure('invalid_request')
  const canonical = new URL(rootUrl)
  canonical.pathname = `/${rootUrl.slice('holo-plugins:///'.length, -1)}/${
    segments.map(segment => decodeURIComponent(segment).replaceAll('%', '%25')).join('/')
  }`
  if (canonical.href !== value) throw failure('invalid_request')
  return value
}

const decodeBytes = (value, limit, metadataUrl, purpose) => {
  if (value === null) return null
  const metadataOnly = value?.metadataOnly === true
  if (
    !ownKeys(value, metadataOnly ? ['base64', 'sha256', 'metadataOnly'] : ['base64', 'sha256']) ||
    (metadataOnly && (purpose !== 'packageMetadata' || !exactPackageMetadataUrl(metadataUrl))) ||
    typeof value.base64 !== 'string' ||
    value.base64.length > Math.ceil(limit / 3) * 4 + 4 ||
    typeof value.sha256 !== 'string' || !HEX_SHA256.test(value.sha256)
  ) {
    throw failure('invalid_response')
  }
  const bytes = Buffer.from(value.base64, 'base64')
  if (
    bytes.byteLength > limit || bytes.toString('base64') !== value.base64 ||
    createHash('sha256').update(bytes).digest('hex') !== value.sha256
  ) {
    throw failure('invalid_response')
  }
  return Object.freeze({ bytes, sha256: value.sha256, ...(metadataOnly ? { metadataOnly: true } : {}) })
}

const decodeResource = (value, requestedUrl, purpose) => {
  const metadataOnly = value?.metadataOnly === true
  if (
    !ownKeys(
      value,
      metadataOnly
        ? ['base64', 'sha256', 'canonicalUrl', 'metadataOnly']
        : ['base64', 'sha256', 'canonicalUrl']
    )
  ) throw failure('invalid_response')
  const canonicalUrl = canonicalResourceUrl(value.canonicalUrl)
  const identitySuffix = url => url.slice('app://workspace'.length + new URL(url).pathname.length)
  if (identitySuffix(canonicalUrl) !== identitySuffix(requestedUrl)) {
    throw failure('invalid_response')
  }
  const selected = decodeBytes(
    { base64: value.base64, sha256: value.sha256, ...(metadataOnly ? { metadataOnly: true } : {}) },
    MAX_FILE_BYTES,
    canonicalUrl,
    purpose
  )
  return Object.freeze({ ...selected, canonicalUrl })
}

const decodeStat = value => {
  if (
    (value?.kind === 'file' || value?.kind === 'directory') &&
    ownKeys(value, ['kind', 'size', 'mtimeMs']) &&
    Number.isSafeInteger(value.size) && value.size >= 0 &&
    Number.isSafeInteger(value.mtimeMs)
  ) {
    return Object.freeze({ kind: value.kind, size: value.size, mtimeMs: value.mtimeMs })
  }
  if (value?.kind === 'missing' && ownKeys(value, ['kind'])) {
    return Object.freeze({ kind: value.kind })
  }
  throw failure('invalid_response')
}

class NativeSourceReader {
  #child
  #nextId = 1
  #queue = []
  #active
  #fragments = []
  #lineBytes = 0
  #closing = false
  #closePromise
  #failed
  #exit
  #signal
  #abortListener
  #timeoutMs
  #packages = new Map()
  #sourceRoots = new Map()

  constructor(child, timeoutMs, signal) {
    this.#child = child
    this.#timeoutMs = timeoutMs
    this.#signal = signal
    this.#exit = new Promise(resolve => child.once('close', resolve))
    child.stdout.on('data', chunk => this.#receive(chunk))
    child.stdout.on('end', () => this.#fail('closed'))
    child.stdout.on('error', () => this.#fail('unavailable'))
    child.stdin.on('error', () => this.#fail('unavailable'))
    child.stderr.on('data', () => {/* Drain diagnostics without retaining private text. */})
    child.on('error', () => this.#fail('unavailable'))
    child.on('close', () => this.#fail('closed'))
    if (signal != null) {
      this.#abortListener = () => this.#fail('cancelled')
      signal.addEventListener('abort', this.#abortListener, { once: true })
      if (signal.aborted) this.#abortListener()
    }
  }

  async init(workspaceRoot) {
    const value = await this.#request('init', { workspaceRoot: absolutePath(workspaceRoot) })
    if (!ownKeys(value, ['rootUrl']) || value.rootUrl !== 'app://workspace/') {
      this.#fail('invalid_response')
      throw failure('invalid_response')
    }
    return this
  }

  async statPrivate(sourcePath) {
    return this.#validated(
      this.#request('statPrivate', { path: absolutePath(sourcePath) }),
      decodeStat
    )
  }

  async reservePrivateDirectory(sourcePath) {
    const value = await this.#request('reservePrivateDirectory', { path: absolutePath(sourcePath) })
    if (value !== true) {
      this.#fail('invalid_response')
      throw failure('invalid_response')
    }
  }

  async readPrivate(sourcePath, kind) {
    if (!['module', 'manifest', 'config', 'schema'].includes(kind)) throw failure('invalid_request')
    return this.#validated(
      this.#request('readPrivate', { path: absolutePath(sourcePath), kind }),
      value => decodeBytes(value, kind === 'module' || kind === 'manifest' ? MAX_FILE_BYTES : MAX_CONFIG_BYTES)
    )
  }

  async openPrivatePackage(root, requestedPackageJson) {
    const selectedRoot = absolutePath(root)
    const selectedPath = absolutePath(requestedPackageJson)
    if (!within(selectedRoot, selectedPath) || path.basename(selectedPath) !== 'package.json') {
      throw failure('invalid_request')
    }
    return this.#validated(
      this.#request('openPrivatePackage', { root: selectedRoot, path: selectedPath }),
      value => {
        if (value === null) return null
        if (!ownKeys(value, ['packageId', 'rootPath', 'base64', 'sha256'])) {
          throw failure('invalid_response')
        }
        const id = packageId(value.packageId)
        const rootPath = absolutePath(value.rootPath)
        if (!within(selectedRoot, rootPath)) throw failure('invalid_response')
        const selected = decodeBytes(
          { base64: value.base64, sha256: value.sha256 },
          MAX_CONFIG_BYTES
        )
        if (selected == null) throw failure('invalid_response')
        const previous = this.#packages.get(id)
        if (previous != null && previous !== rootPath) throw failure('invalid_response')
        if (previous == null && this.#packages.size >= MAX_PACKAGE_LEASES) throw failure('invalid_response')
        this.#packages.set(id, rootPath)
        return Object.freeze({ packageId: id, rootPath, ...selected })
      }
    )
  }

  async readPrivatePackage(id, relativePath, kind) {
    if (!this.#packages.has(id) || !['module', 'schema'].includes(kind)) {
      throw failure('invalid_request')
    }
    const selectedPath = packageRelativePath(relativePath)
    return this.#validated(
      this.#request('readPrivatePackage', { packageId: id, relativePath: selectedPath, kind }),
      value => decodeBytes(value, kind === 'module' ? MAX_FILE_BYTES : MAX_CONFIG_BYTES)
    )
  }

  async openPrivateSourceRoot(rootPath, rootUrl, pinnedPackageId) {
    const selectedPath = absolutePath(rootPath)
    const selectedUrl = canonicalPrivateRootUrl(rootUrl)
    if (pinnedPackageId != null && !this.#packages.has(pinnedPackageId)) {
      throw failure('invalid_request')
    }
    return this.#validated(
      this.#request('openPrivateSourceRoot', {
        rootPath: selectedPath,
        rootUrl: selectedUrl,
        ...(pinnedPackageId == null ? {} : { packageId: pinnedPackageId })
      }),
      value => {
        if (!ownKeys(value, ['sourceRootId', 'rootPath'])) throw failure('invalid_response')
        const id = packageId(value.sourceRootId)
        if (absolutePath(value.rootPath) !== selectedPath) throw failure('invalid_response')
        const previous = this.#sourceRoots.get(id)
        if (previous != null && previous !== selectedUrl) throw failure('invalid_response')
        if (previous == null && this.#sourceRoots.size >= MAX_PACKAGE_LEASES) {
          throw failure('invalid_response')
        }
        this.#sourceRoots.set(id, selectedUrl)
        return Object.freeze({ sourceRootId: id, rootPath: selectedPath })
      }
    )
  }

  async readPrivateSourceResource(sourceRootId, url, purpose) {
    const rootUrl = this.#sourceRoots.get(sourceRootId)
    if (rootUrl == null) throw failure('invalid_request')
    const requested = canonicalPrivateResourceUrl(url, rootUrl)
    const selectedPurpose = readPurpose(purpose)
    return this.#validated(
      this.#request('readPrivateSourceResource', {
        sourceRootId,
        url: requested,
        ...(selectedPurpose === undefined ? {} : { purpose: selectedPurpose })
      }),
      value => {
        if (value === null) return null
        if (!ownKeys(value, ['base64', 'sha256', 'canonicalUrl'])) {
          throw failure('invalid_response')
        }
        const canonicalUrl = canonicalPrivateResourceUrl(value.canonicalUrl, rootUrl)
        const selected = decodeBytes(
          { base64: value.base64, sha256: value.sha256 },
          MAX_FILE_BYTES
        )
        if (selected == null) throw failure('invalid_response')
        return Object.freeze({ ...selected, canonicalUrl })
      }
    )
  }

  async capturePrivate(sourcePath) {
    const value = await this.#request('capturePrivate', { path: absolutePath(sourcePath) })
    if (value === null) return null
    return this.#validated(Promise.resolve(value), stat => {
      const selected = decodeStat(stat)
      if (selected.kind !== 'file') throw failure('invalid_response')
      return selected
    })
  }

  async seal() {
    const value = await this.#request('seal', {})
    if (value !== true) {
      this.#fail('invalid_response')
      throw failure('invalid_response')
    }
  }

  async readGuest(url, purpose) {
    const requested = canonicalGuestUrl(url)
    const selectedPurpose = readPurpose(purpose)
    return this.#validated(
      this.#request('readGuest', {
        url: requested,
        ...(selectedPurpose === undefined ? {} : { purpose: selectedPurpose })
      }),
      value => decodeBytes(value, MAX_FILE_BYTES, requested, selectedPurpose ?? 'module')
    )
  }

  async readGuestResource(url, purpose) {
    const requestedUrl = canonicalGuestUrl(url)
    const selectedPurpose = readPurpose(purpose)
    return this.#validated(
      this.#request('readGuestResource', {
        url: requestedUrl,
        ...(selectedPurpose === undefined ? {} : { purpose: selectedPurpose })
      }),
      value => value === null ? null : decodeResource(value, requestedUrl, selectedPurpose ?? 'module')
    )
  }

  async #validated(promise, decode) {
    const value = await promise
    try {
      return decode(value)
    } catch {
      this.#fail('invalid_response')
      throw failure('invalid_response')
    }
  }

  close() {
    if (this.#closePromise) return this.#closePromise
    this.#closing = true
    this.#closePromise = this.#closeOwned()
    return this.#closePromise
  }

  async #closeOwned() {
    // A pending source read must not hold close behind the serialized queue.
    if (this.#active || this.#queue.length > 0) this.#fail('closed')
    else if (!this.#failed) {
      try {
        const value = await this.#request('close', {}, 1_000)
        if (value !== true) this.#fail('invalid_response')
      } catch {
        // Process teardown remains authoritative after a failed close frame.
      }
    }
    this.#child.stdin.end()
    const force = setTimeout(() => this.#child.kill('SIGKILL'), 1_000)
    force.unref()
    let ceiling
    await Promise.race([
      this.#exit,
      new Promise(resolve => {
        ceiling = setTimeout(() => {
          this.#child.kill('SIGKILL')
          resolve()
        }, 2_000)
        ceiling.unref()
      })
    ])
    clearTimeout(force)
    clearTimeout(ceiling)
    if (this.#signal != null) this.#signal.removeEventListener('abort', this.#abortListener)
    this.#packages.clear()
  }

  #request(op, fields, timeoutMs = this.#timeoutMs) {
    if (this.#failed) return Promise.reject(this.#failed)
    if (this.#closing && op !== 'close') return Promise.reject(failure('closed'))
    if (this.#queue.length >= MAX_QUEUE || this.#nextId > Number.MAX_SAFE_INTEGER) {
      return Promise.reject(failure('limit'))
    }
    const id = this.#nextId++
    const line = `${JSON.stringify({ schemaVersion: 1, id, op, ...fields })}\n`
    if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) return Promise.reject(failure('limit'))
    return new Promise((resolve, reject) => {
      const item = { id, line, resolve, reject }
      item.timer = setTimeout(() => this.#fail('timeout'), timeoutMs)
      item.timer.unref()
      this.#queue.push(item)
      this.#pump()
    })
  }

  #pump() {
    if (this.#active || this.#queue.length === 0 || this.#failed) return
    const active = this.#queue.shift()
    this.#active = active
    this.#child.stdin.write(active.line, error => {
      if (error) this.#fail('unavailable')
    })
  }

  #receive(chunk) {
    if (this.#failed) return
    let start = 0
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue
      this.#fragments.push(chunk.subarray(start, index))
      this.#lineBytes += index - start
      if (this.#lineBytes > MAX_LINE_BYTES) return this.#fail('limit')
      const line = Buffer.concat(this.#fragments, this.#lineBytes)
      this.#fragments = []
      this.#lineBytes = 0
      this.#response(line)
      if (this.#failed) return
      start = index + 1
    }
    if (start < chunk.length) {
      this.#fragments.push(chunk.subarray(start))
      this.#lineBytes += chunk.length - start
      if (this.#lineBytes > MAX_LINE_BYTES) this.#fail('limit')
    }
  }

  #response(line) {
    const active = this.#active
    if (!active || line.length === 0) return this.#fail('invalid_response')
    let value
    try {
      value = JSON.parse(UTF8.decode(line))
    } catch {
      return this.#fail('invalid_response')
    }
    if (
      value?.schemaVersion !== 1 || value.id !== active.id || typeof value.ok !== 'boolean' ||
      !(value.ok
        ? ownKeys(value, ['schemaVersion', 'id', 'ok', 'value'])
        : ownKeys(value, ['schemaVersion', 'id', 'ok', 'code']))
    ) {
      return this.#fail('invalid_response')
    }
    if (!value.ok && !NATIVE_ERROR_CODES.has(value.code)) {
      return this.#fail('invalid_response')
    }
    clearTimeout(active.timer)
    this.#active = undefined
    if (value.ok) active.resolve(value.value)
    else active.reject(failure(value.code))
    this.#pump()
  }

  #fail(code) {
    if (this.#failed) return
    this.#failed = failure(code)
    this.#fragments = []
    this.#lineBytes = 0
    if (this.#active) {
      clearTimeout(this.#active.timer)
      this.#active.reject(this.#failed)
      this.#active = undefined
    }
    for (const item of this.#queue.splice(0)) {
      clearTimeout(item.timer)
      item.reject(this.#failed)
    }
    if (!this.#child.killed) this.#child.kill('SIGTERM')
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), 1_000)
    timer.unref()
    this.#exit.then(() => clearTimeout(timer))
  }
}

export const createNativeSourceReader = async ({ binaryPath, workspaceRoot, timeoutMs = 10_000, signal } = {}) => {
  absolutePath(binaryPath)
  absolutePath(workspaceRoot)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw failure('invalid_request')
  }
  if (signal?.aborted) throw failure('cancelled')
  let child
  try {
    child = spawn(binaryPath, ['__source_snapshot_v1'], {
      cwd: workspaceRoot,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch {
    throw failure('unavailable')
  }
  const reader = new NativeSourceReader(child, timeoutMs, signal)
  try {
    return await reader.init(workspaceRoot)
  } catch (error) {
    await reader.close()
    throw error
  }
}
