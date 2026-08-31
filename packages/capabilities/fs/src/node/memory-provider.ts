/* eslint-disable max-lines -- the conformance-only provider keeps authorization, tree mutation and NativePort ownership together. */

import { authorizeFsPath, createFsAuthorityRegistry, resolveProviderAuthority } from './authority.js'
import { FS_NATIVE_MODULE, FS_OPERATIONS } from './constants.js'
import { fsFailure, fsSuccess } from './contract.js'
import { createFsError, isHolonomyFsError } from './errors.js'
import { parseOpenFlags } from './open-flags.js'
import { formatFsPath, parseFsPath } from './path.js'

import type {
  NativeBinary,
  NativeCallToken,
  NativeDispatchContext,
  NativePort,
  NativePortEventSink,
  NativePortRequest,
  NativePortResourceEventSink,
  NativePortResourceGrant,
  NativeProviderToken
} from '@holonomyjs/runtime/native-port/types'
import type {
  FsAuthority,
  FsErrorCode,
  FsPermission,
  FsRootAuthority,
  FsRootGrant,
  MemoryFsLimits,
  MemoryFsProviderSnapshot,
  ParsedFsPath
} from './types.js'

type Entry = DirectoryEntry | FileEntry | SymlinkEntry

interface EntryBase {
  birthtimeMs: number
  ctimeMs: number
  mode: number
  mtimeMs: number
}

interface DirectoryEntry extends EntryBase {
  children: Map<string, Entry>
  kind: 'directory'
}

interface FileEntry extends EntryBase {
  data: Uint8Array
  kind: 'file'
}

interface SymlinkEntry extends EntryBase {
  kind: 'symlink'
  target: ParsedFsPath
}

interface FileResource {
  append: boolean
  authority: FsRootAuthority
  entry: Entry
  offset: number
  owner: NativeCallToken
  path: ParsedFsPath
  readable: boolean
  rootId: string
  writable: boolean
}

interface AtomicWriteResource {
  authority: FsRootAuthority
  callTokens: Set<NativeCallToken>
  create: boolean
  entry: FileEntry
  noFollow: boolean
  owner: NativeCallToken
  path: ParsedFsPath
  principal: string
  rootId: string
  state: 'aborted' | 'committed' | 'open' | 'writing'
  token: NativeProviderToken
}

interface StreamRecord {
  callToken: NativeCallToken
  id: string
  cursor: number
  end: number
  file: FileEntry
  sink: NativePortEventSink
  chunkSize: number
  sequence: number
}

interface WatchRecord {
  callToken: NativeCallToken
  credits: number
  events: Array<{ eventType: 'change' | 'rename'; filename: string }>
  id: string
  path: ParsedFsPath
  sequence: number
  sink: NativePortEventSink
}

const DEFAULT_LIMITS: MemoryFsLimits = {
  maxChunkBytes: 64 * 1024,
  maxDirectoryEntries: 1024,
  maxEntries: 4096,
  maxFileBytes: 16 * 1024 * 1024,
  maxOpenHandles: 64,
  maxTotalBytes: 64 * 1024 * 1024,
  maxWatchEvents: 1024
}

const now = () => Date.now()

const directory = (mode = 0o777): DirectoryEntry => ({
  birthtimeMs: now(),
  children: new Map(),
  ctimeMs: now(),
  kind: 'directory',
  mode,
  mtimeMs: now()
})

const file = (mode = 0o666): FileEntry => ({
  birthtimeMs: now(),
  ctimeMs: now(),
  data: new Uint8Array(),
  kind: 'file',
  mode,
  mtimeMs: now()
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

const read = (value: Record<string, unknown>, key: string) => value[key]

const requireExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[]
) => {
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expected.length ||
    keys.some(key => typeof key !== 'string' || !expected.includes(key))
  ) {
    throw createFsError('EINVAL')
  }
}

const requirePath = (value: unknown, operation: string) => {
  if (typeof value !== 'string') throw createFsError('EINVAL')
  return parseFsPath(value, operation as never)
}

const requireBoolean = (value: unknown, fallback = false) => {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw createFsError('EINVAL')
  return value
}

const requireInteger = (value: unknown, fallback?: number) => {
  const resolved = value === undefined ? fallback : value
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 0) {
    throw createFsError('EINVAL')
  }
  return resolved as number
}

const fsDomainError = (code: FsErrorCode) => {
  switch (code) {
    case 'EEXIST':
      return { code: 'exists', domain: 'fs' } as const
    case 'ENOENT':
      return { code: 'not_found', domain: 'fs' } as const
    case 'EACCES':
      return { code: 'permission_denied', domain: 'fs' } as const
    default:
      return { code: 'invalid_request', domain: 'runtime' } as const
  }
}

export class MemoryFsNativePort implements NativePort {
  readonly #authorities: ReadonlyMap<string, Readonly<FsAuthority>>
  readonly #files = new Map<NativeProviderToken, FileResource>()
  readonly #roots = new Map<string, DirectoryEntry>()
  readonly #streams = new Map<NativeCallToken, StreamRecord>()
  readonly #transactionByCallToken = new Map<NativeCallToken, NativeProviderToken>()
  readonly #transactions = new Map<NativeProviderToken, AtomicWriteResource>()
  readonly #watchers = new Map<NativeCallToken, WatchRecord>()
  readonly #limits: MemoryFsLimits
  #disposed = false
  #nextToken = 1

  constructor(options: {
    authorities: readonly Readonly<FsAuthority>[]
    limits?: Partial<MemoryFsLimits>
  }) {
    this.#authorities = createFsAuthorityRegistry(options.authorities)
    this.#limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits })
  }

  cancel(callToken: NativeCallToken, _reason?: string) {
    this.#streams.delete(callToken)
    this.#watchers.delete(callToken)
    const token = this.#transactionByCallToken.get(callToken)
    const transaction = token == null ? undefined : this.#transactions.get(token)
    if (transaction != null && this.isActiveTransaction(transaction)) {
      this.abortTransaction(transaction)
    }
  }

  closeResource(
    owner: NativeCallToken,
    providerToken: NativeProviderToken,
    _reason?: string
  ) {
    const resource = this.#files.get(providerToken)
    if (resource?.owner === owner) {
      this.#files.delete(providerToken)
      return
    }
    const transaction = this.#transactions.get(providerToken)
    if (transaction?.owner !== owner) return
    if (this.isActiveTransaction(transaction)) this.abortTransaction(transaction)
    this.releaseTransaction(transaction)
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#files.clear()
    this.#streams.clear()
    for (const transaction of this.#transactions.values()) {
      if (this.isActiveTransaction(transaction)) this.abortTransaction(transaction)
    }
    this.#transactionByCallToken.clear()
    this.#transactions.clear()
    this.#watchers.clear()
  }

  dispatch(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    _resourceSink: NativePortResourceEventSink
  ) {
    if (this.#disposed) {
      sink({ error: { code: 'disposed' }, id: request.id, type: 'error' })
      return
    }
    try {
      const authority = resolveProviderAuthority(this.#authorities, context)
      if (request.module !== FS_NATIVE_MODULE || !isRecord(request.args)) {
        throw createFsError('EINVAL')
      }
      if (request.operation === FS_OPERATIONS.readStream) {
        this.openReadStream(request, context, authority, sink)
        return
      }
      if (request.operation === FS_OPERATIONS.watch) {
        this.openWatcher(request, context, authority, sink)
        return
      }
      const output = this.execute(request, context, authority)
      if (isRecord(output) && ('binary' in output || 'resources' in output)) {
        const binary = Array.isArray(output.binary)
          ? output.binary as readonly NativeBinary<Uint8Array>[]
          : undefined
        const resources = Array.isArray(output.resources)
          ? output.resources as readonly NativePortResourceGrant[]
          : undefined
        const value = output.value
        sink({
          ...(binary == null ? {} : { binary }),
          id: request.id,
          ...(resources == null ? {} : { resources }),
          ...fsSuccess(value as never),
          type: 'result'
        })
        return
      }
      sink({ id: request.id, ...fsSuccess(output as never), type: 'result' })
    } catch (error) {
      const fsError = isHolonomyFsError(error)
        ? error
        : createFsError('EIO')
      if (!['EACCES', 'EEXIST', 'ENOENT'].includes(fsError.code)) {
        sink({ id: request.id, ...fsFailure(fsError.code), type: 'result' })
        return
      }
      sink({ error: fsDomainError(fsError.code), id: request.id, type: 'error' })
    }
  }

  getSnapshot(): MemoryFsProviderSnapshot {
    let entries = 0
    let totalBytes = 0
    let transactionBytes = 0
    const files = new Set<FileEntry>()
    const visit = (entry: Entry) => {
      entries += 1
      if (entry.kind === 'file') files.add(entry)
      if (entry.kind === 'directory') entry.children.forEach(visit)
    }
    this.#roots.forEach(visit)
    this.#files.forEach(resource => {
      if (resource.entry.kind === 'file') files.add(resource.entry)
    })
    this.#transactions.forEach(transaction => {
      if (!this.isActiveTransaction(transaction)) return
      files.add(transaction.entry)
      transactionBytes += transaction.entry.data.byteLength
    })
    files.forEach(entry => {
      totalBytes += entry.data.byteLength
    })
    return {
      disposed: this.#disposed,
      entries,
      openHandles: this.#files.size + this.#transactions.size,
      pendingTransactions: [...this.#transactions.values()].filter(
        transaction => this.isActiveTransaction(transaction)
      ).length,
      pendingStreams: this.#streams.size + this.#watchers.size,
      totalBytes,
      transactionBytes
    }
  }

  grantCredits(callToken: NativeCallToken, credits: number) {
    const stream = this.#streams.get(callToken)
    if (!Number.isSafeInteger(credits) || credits <= 0) return
    if (!stream) {
      const watcher = this.#watchers.get(callToken)
      if (!watcher) return
      watcher.credits += credits
      this.flushWatcher(watcher)
      return
    }
    for (let index = 0; index < credits && this.#streams.has(callToken); index += 1) {
      if (stream.cursor >= stream.end) {
        this.#streams.delete(callToken)
        stream.sink({ id: stream.id, ...fsSuccess({ bytesRead: stream.cursor }), type: 'end' })
        return
      }
      const end = Math.min(stream.end, stream.cursor + stream.chunkSize)
      const bytes = stream.file.data.slice(stream.cursor, end)
      stream.cursor = end
      stream.sink({
        binary: [{ data: bytes, handle: 'data' }],
        id: stream.id,
        sequence: stream.sequence++,
        ...fsSuccess(),
        type: 'chunk'
      })
    }
  }

  private execute(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    authority: Readonly<FsAuthority>
  ) {
    const args = request.args as Record<string, unknown>
    switch (request.operation) {
      case FS_OPERATIONS.access:
        return this.access(args, authority)
      case FS_OPERATIONS.atomicWriteBegin:
        return this.beginAtomicWrite(args, context, authority, request)
      case FS_OPERATIONS.atomicWriteChunk:
        return this.writeAtomicChunk(args, context, authority, request)
      case FS_OPERATIONS.atomicWriteCommit:
        return this.commitAtomicWrite(args, context, authority, request)
      case FS_OPERATIONS.chmod:
        return this.chmod(args, authority)
      case FS_OPERATIONS.cp:
        return this.copy(args, authority)
      case FS_OPERATIONS.handleRead:
        return this.handleRead(args, context, authority)
      case FS_OPERATIONS.handleStat:
        return this.handleStat(args, context, authority)
      case FS_OPERATIONS.handleSync:
        return this.handleSync(args, context, authority)
      case FS_OPERATIONS.handleWrite:
        return this.handleWrite(args, context, authority, request)
      case FS_OPERATIONS.lstat:
        return this.stat(args, authority, false)
      case FS_OPERATIONS.mkdir:
        return this.mkdir(args, authority)
      case FS_OPERATIONS.open:
        return this.open(args, authority, context.callToken, request)
      case FS_OPERATIONS.readdir:
        return this.readdir(args, authority)
      case FS_OPERATIONS.readlink:
        return this.readlink(args, authority)
      case FS_OPERATIONS.realpath:
        return this.realpath(args, authority)
      case FS_OPERATIONS.rename:
        return this.rename(args, authority)
      case FS_OPERATIONS.rm:
        return this.rm(args, authority)
      case FS_OPERATIONS.stat:
        return this.stat(args, authority, true)
      case FS_OPERATIONS.symlink:
        return this.symlink(args, authority)
      default:
        throw createFsError('EINVAL')
    }
  }

  private access(args: Record<string, unknown>, authority: Readonly<FsAuthority>) {
    const path = requirePath(read(args, 'path'), 'access')
    const mode = requireInteger(read(args, 'mode'), 0)
    if ((mode & ~7) !== 0 || (mode & 1) !== 0) {
      throw createFsError('ERR_HOLONOMY_NOT_SUPPORTED')
    }
    if ((mode & 4) !== 0) authorizeFsPath(authority, path, 'read', 'access')
    if ((mode & 2) !== 0) authorizeFsPath(authority, path, 'write', 'access')
    const permission: FsPermission = (mode & 4) !== 0
      ? 'read'
      : (mode & 2) !== 0
      ? 'write'
      : 'metadata'
    this.resolve(authority, path, true, permission)
    return {}
  }

  private beginAtomicWrite(
    args: Record<string, unknown>,
    context: Readonly<NativeDispatchContext>,
    authority: Readonly<FsAuthority>,
    request: NativePortRequest
  ) {
    requireExactKeys(args, ['flags', 'mode', 'path'])
    if (context.resources.length !== 0 || request.binary?.length) {
      throw createFsError('EINVAL')
    }
    const path = requirePath(read(args, 'path'), 'writeFile')
    const flags = parseOpenFlags(requireInteger(read(args, 'flags')), 'writeFile')
    const mode = requireInteger(read(args, 'mode'), 0o666)
    if (
      mode > 0o7777 ||
      !flags.writable ||
      !flags.truncate ||
      flags.append ||
      flags.directory ||
      flags.exclusive
    ) {
      throw createFsError('EINVAL')
    }
    const grant = authorizeFsPath(authority, path, 'write', 'writeFile')
    const parent = this.parent(authority, path, 'write').directory
    const name = path.segments.at(-1)
    if (!name) throw createFsError('EISDIR')
    const existing = parent.children.get(name)
    if (existing == null && !flags.create) throw createFsError('ENOENT')
    if (existing?.kind === 'directory') throw createFsError('EISDIR')
    if (existing?.kind === 'symlink' && flags.noFollow) throw createFsError('EPERM')
    if (this.#files.size + this.#transactions.size >= this.#limits.maxOpenHandles) {
      throw createFsError('ENOSPC')
    }
    const token = this.allocateProviderToken('fs-atomic-write')
    const transaction: AtomicWriteResource = {
      authority: path.authority,
      callTokens: new Set(),
      create: flags.create,
      entry: file(existing?.kind === 'file' ? existing.mode : mode),
      noFollow: flags.noFollow,
      owner: context.callToken,
      path,
      principal: authority.principal,
      rootId: grant.rootId,
      state: 'open',
      token
    }
    this.#transactions.set(token, transaction)
    return { resources: [{ providerToken: token, type: 'fs.atomic-write' }] }
  }

  private writeAtomicChunk(
    args: Record<string, unknown>,
    context: Readonly<NativeDispatchContext>,
    authority: Readonly<FsAuthority>,
    request: NativePortRequest
  ) {
    requireExactKeys(args, ['transaction'])
    const transaction = this.atomicWriteResource(args, context, authority)
    const binary = request.binary
    if (
      binary == null ||
      binary.length !== 1 ||
      binary[0]?.handle !== 'data' ||
      !(binary[0].data instanceof Uint8Array) ||
      binary[0].data.byteLength === 0 ||
      binary[0].data.byteLength > this.#limits.maxChunkBytes
    ) {
      throw createFsError('EINVAL')
    }
    this.trackTransactionCall(transaction, context.callToken)
    const end = transaction.entry.data.byteLength + binary[0].data.byteLength
    if (
      end > this.#limits.maxFileBytes ||
      this.totalBytes() - transaction.entry.data.byteLength + end > this.#limits.maxTotalBytes
    ) {
      throw createFsError('ENOSPC')
    }
    const data = new Uint8Array(end)
    data.set(transaction.entry.data)
    data.set(binary[0].data, transaction.entry.data.byteLength)
    transaction.entry.data = data
    transaction.entry.mtimeMs = now()
    transaction.state = 'writing'
    return { bytesWritten: binary[0].data.byteLength }
  }

  private commitAtomicWrite(
    args: Record<string, unknown>,
    context: Readonly<NativeDispatchContext>,
    authority: Readonly<FsAuthority>,
    request: NativePortRequest
  ) {
    requireExactKeys(args, ['transaction'])
    if (request.binary?.length) throw createFsError('EINVAL')
    const transaction = this.atomicWriteResource(args, context, authority)
    this.trackTransactionCall(transaction, context.callToken)
    const parent = this.parent(authority, transaction.path, 'write').directory
    const name = transaction.path.segments.at(-1)
    if (!name) throw createFsError('EISDIR')
    const existing = parent.children.get(name)
    if (existing == null && !transaction.create) throw createFsError('ENOENT')
    if (existing?.kind === 'directory') throw createFsError('EISDIR')
    if (existing?.kind === 'symlink' && transaction.noFollow) {
      throw createFsError('EPERM')
    }
    const snapshot = this.getSnapshot()
    if (
      snapshot.entries + (existing == null ? 1 : 0) > this.#limits.maxEntries ||
      snapshot.totalBytes > this.#limits.maxTotalBytes
    ) {
      throw createFsError('ENOSPC')
    }
    this.assertDirectoryCapacity(parent, name)
    parent.children.set(name, transaction.entry)
    transaction.entry.ctimeMs = now()
    transaction.entry.mtimeMs = now()
    transaction.state = 'committed'
    this.notifyWatchers(FS_OPERATIONS.chmod, { path: transaction.path.href })
    return {}
  }

  private chmod(args: Record<string, unknown>, authority: Readonly<FsAuthority>) {
    const path = requirePath(read(args, 'path'), 'chmod')
    const mode = requireInteger(read(args, 'mode'))
    if (mode > 0o7777) throw createFsError('EINVAL')
    const entry = this.resolve(authority, path, true, 'write').entry
    entry.mode = mode
    entry.ctimeMs = now()
    this.notifyWatchers(FS_OPERATIONS.chmod, { path: path.href })
    return {}
  }

  private copy(args: Record<string, unknown>, authority: Readonly<FsAuthority>) {
    const source = requirePath(read(args, 'source'), 'cp')
    const destination = requirePath(read(args, 'destination'), 'cp')
    const recursive = requireBoolean(read(args, 'recursive'))
    const force = requireBoolean(read(args, 'force'), true)
    const errorOnExist = requireBoolean(read(args, 'errorOnExist'))
    const from = this.resolve(authority, source, false, 'read').entry
    if (from.kind === 'directory' && !recursive) throw createFsError('EISDIR')
    if (
      from.kind === 'directory' &&
      source.authority === destination.authority &&
      source.segments.every((segment, index) => destination.segments[index] === segment)
    ) {
      throw createFsError('EINVAL')
    }
    const target = this.parent(authority, destination, 'write')
    const name = destination.segments.at(-1)
    if (!name) throw createFsError('EPERM')
    const existing = target.directory.children.get(name)
    if (existing) {
      if (errorOnExist || !force) throw createFsError('EEXIST')
    }
    const copied = this.clone(from)
    const existingSize = existing == null ? { entries: 0 } : { entries: this.entrySize(existing).entries }
    const copiedSize = this.entrySize(copied)
    const snapshot = this.getSnapshot()
    if (
      snapshot.entries - existingSize.entries + copiedSize.entries > this.#limits.maxEntries ||
      snapshot.totalBytes - this.releasedBytes(existing) + copiedSize.bytes > this.#limits.maxTotalBytes
    ) {
      throw createFsError('ENOSPC')
    }
    this.assertDirectoryCapacity(target.directory, name)
    target.directory.children.set(name, copied)
    this.notifyWatchers(FS_OPERATIONS.cp, { destination: destination.href })
    return {}
  }

  private handleRead(
    args: Record<string, unknown>,
    context: Readonly<NativeDispatchContext>,
    authority: Readonly<FsAuthority>
  ) {
    const resource = this.fileResource(args, context, authority, 'read')
    const length = Math.min(requireInteger(read(args, 'length')), this.#limits.maxChunkBytes)
    const position = read(args, 'position')
    const start = position === null ? resource.offset : requireInteger(position)
    if (!this.canRead(resource)) throw createFsError('EACCES')
    if (resource.entry.kind !== 'file') throw createFsError('EISDIR')
    const bytes = resource.entry.data.slice(start, start + length)
    if (position === null) resource.offset = start + bytes.byteLength
    return { binary: [{ data: bytes, handle: 'data' }], value: { bytesRead: bytes.byteLength } }
  }

  private handleStat(
    args: Record<string, unknown>,
    context: Readonly<NativeDispatchContext>,
    authority: Readonly<FsAuthority>
  ) {
    return this.statRecord(this.fileResource(args, context, authority, 'metadata').entry)
  }

  private handleSync(
    args: Record<string, unknown>,
    context: Readonly<NativeDispatchContext>,
    authority: Readonly<FsAuthority>
  ) {
    this.fileResource(args, context, authority, 'write')
    return {}
  }

  private handleWrite(
    args: Record<string, unknown>,
    context: Readonly<NativeDispatchContext>,
    authority: Readonly<FsAuthority>,
    request: NativePortRequest
  ) {
    const resource = this.fileResource(args, context, authority, 'write')
    if (!this.canWrite(resource)) throw createFsError('EACCES')
    const binary = request.binary?.find(item => item.handle === 'data')?.data
    if (!(binary instanceof Uint8Array) || binary.byteLength > this.#limits.maxChunkBytes) throw createFsError('EINVAL')
    const position = read(args, 'position')
    if (resource.entry.kind !== 'file') throw createFsError('EISDIR')
    const start = resource.append
      ? resource.entry.data.byteLength
      : position === null
      ? resource.offset
      : requireInteger(position)
    const end = start + binary.byteLength
    if (
      end > this.#limits.maxFileBytes ||
      this.totalBytes() - resource.entry.data.byteLength + end > this.#limits.maxTotalBytes
    ) throw createFsError('ENOSPC')
    const data = new Uint8Array(Math.max(end, resource.entry.data.byteLength))
    data.set(resource.entry.data)
    data.set(binary, start)
    resource.entry.data = data
    resource.entry.mtimeMs = now()
    this.notifyWatchers(FS_OPERATIONS.chmod, { path: resource.path.href })
    if (position === null || resource.append) resource.offset = end
    return { bytesWritten: binary.byteLength }
  }

  private mkdir(args: Record<string, unknown>, authority: Readonly<FsAuthority>) {
    const path = requirePath(read(args, 'path'), 'mkdir')
    const mode = requireInteger(read(args, 'mode'), 0o777)
    const recursive = requireBoolean(read(args, 'recursive'))
    authorizeFsPath(authority, path, 'write', 'mkdir')
    const root = this.root(authority.roots[path.authority]!)
    let current = root
    let created: string | null = null
    for (let index = 0; index < path.segments.length; index += 1) {
      const name = path.segments[index]!
      const existing = current.children.get(name)
      if (existing) {
        if (existing.kind !== 'directory') throw createFsError('ENOTDIR')
        current = existing
        continue
      }
      if (!recursive && index !== path.segments.length - 1) throw createFsError('ENOENT')
      this.assertEntryCapacity()
      this.assertDirectoryCapacity(current, name)
      const child = directory(mode)
      current.children.set(name, child)
      current = child
      created ??= formatFsPath(path.authority, path.segments.slice(0, index + 1))
    }
    if (created != null) this.notifyWatchers(FS_OPERATIONS.mkdir, { path: path.href })
    if (created === null && !recursive) throw createFsError('EEXIST')
    return { created }
  }

  private open(
    args: Record<string, unknown>,
    authority: Readonly<FsAuthority>,
    owner: NativeCallToken,
    request: NativePortRequest
  ) {
    const path = requirePath(read(args, 'path'), 'open')
    const flags = parseOpenFlags(requireInteger(read(args, 'flags')))
    const mode = requireInteger(read(args, 'mode'), 0o666)
    const grant = authorizeFsPath(authority, path, flags.writable ? 'write' : 'read', 'open')
    if (flags.readable) authorizeFsPath(authority, path, 'read', 'open')
    if (this.#files.size >= this.#limits.maxOpenHandles) throw createFsError('ENOSPC')
    let resolved: { entry: Entry; parent?: DirectoryEntry }
    let created = false
    try {
      resolved = this.resolve(authority, path, !flags.noFollow, flags.writable ? 'write' : 'read')
    } catch (error) {
      if (
        !(error instanceof Error) || !('code' in error) || (error as { code: string }).code !== 'ENOENT' ||
        !flags.create
      ) throw error
      const parent = this.parent(authority, path, 'write').directory
      const name = path.segments.at(-1)
      if (!name) throw createFsError('EISDIR')
      this.assertEntryCapacity()
      this.assertDirectoryCapacity(parent, name)
      const entry = file(mode)
      parent.children.set(name, entry)
      resolved = { entry, parent }
      created = true
    }
    if (resolved.entry.kind === 'symlink') {
      if (flags.noFollow) throw createFsError('EPERM')
      resolved = this.resolve(authority, path, true, flags.writable ? 'write' : 'read')
    }
    if (resolved.entry.kind === 'directory' && !flags.directory) throw createFsError('EISDIR')
    if (resolved.entry.kind !== 'directory' && flags.directory) throw createFsError('ENOTDIR')
    if (resolved.entry.kind === 'symlink') throw createFsError('EINVAL')
    const openedFile = resolved.entry
    if (flags.exclusive && flags.create && !created) throw createFsError('EEXIST')
    const changed = created || flags.truncate
    if (flags.truncate) {
      if (openedFile.kind !== 'file') throw createFsError('EISDIR')
      openedFile.data = new Uint8Array()
    }
    const token = this.allocateProviderToken('fs-file')
    this.#files.set(token, {
      append: flags.append,
      authority: path.authority,
      entry: openedFile,
      offset: flags.append && openedFile.kind === 'file' ? openedFile.data.byteLength : 0,
      owner,
      path,
      readable: flags.readable,
      rootId: grant.rootId,
      writable: flags.writable
    })
    if (changed) this.notifyWatchers(FS_OPERATIONS.open, { path: path.href })
    return { resources: [{ providerToken: token, type: 'fs.file' }] }
  }

  private readdir(args: Record<string, unknown>, authority: Readonly<FsAuthority>) {
    const path = requirePath(read(args, 'path'), 'readdir')
    const entry = this.resolve(authority, path, true, 'read').entry
    if (entry.kind !== 'directory') throw createFsError('ENOTDIR')
    if (entry.children.size > this.#limits.maxDirectoryEntries) throw createFsError('ENOSPC')
    return {
      entries: [...entry.children].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => ({
        kind: child.kind === 'directory' ? 'directory' : child.kind === 'file' ? 'file' : 'symlink',
        name
      }))
    }
  }

  private readlink(args: Record<string, unknown>, authority: Readonly<FsAuthority>) {
    const path = requirePath(read(args, 'path'), 'readlink')
    const entry = this.resolve(authority, path, false, 'read').entry
    if (entry.kind !== 'symlink') throw createFsError('EINVAL')
    return { path: entry.target.href }
  }

  private realpath(args: Record<string, unknown>, authority: Readonly<FsAuthority>) {
    const path = requirePath(read(args, 'path'), 'realpath')
    return { path: this.resolve(authority, path, true, 'metadata').path.href }
  }

  private rename(args: Record<string, unknown>, authority: Readonly<FsAuthority>) {
    const source = requirePath(read(args, 'source'), 'rename')
    const destination = requirePath(read(args, 'destination'), 'rename')
    if (source.authority !== destination.authority) throw createFsError('EXDEV')
    const from = this.parent(authority, source, 'write')
    const sourceName = source.segments.at(-1)
    const destinationName = destination.segments.at(-1)
    if (!sourceName || !destinationName) throw createFsError('EPERM')
    const entry = from.directory.children.get(sourceName)
    if (!entry) throw createFsError('ENOENT')
    const to = this.parent(authority, destination, 'write')
    const existing = to.directory.children.get(destinationName)
    if (existing?.kind === 'directory' && existing.children.size > 0) throw createFsError('ENOTEMPTY')
    if (source.href === destination.href) return {}
    if (
      entry.kind === 'directory' &&
      source.segments.every((segment, index) => destination.segments[index] === segment)
    ) {
      throw createFsError('EINVAL')
    }
    if (from.directory !== to.directory || existing != null) {
      this.assertDirectoryCapacity(to.directory, destinationName)
    }
    to.directory.children.set(destinationName, entry)
    from.directory.children.delete(sourceName)
    this.notifyWatchers(FS_OPERATIONS.rename, { destination: destination.href, source: source.href })
    return {}
  }

  private rm(args: Record<string, unknown>, authority: Readonly<FsAuthority>) {
    const path = requirePath(read(args, 'path'), 'rm')
    const force = requireBoolean(read(args, 'force'))
    const recursive = requireBoolean(read(args, 'recursive'))
    const parent = this.parent(authority, path, 'write')
    const name = path.segments.at(-1)
    if (!name) throw createFsError('EPERM')
    const entry = parent.directory.children.get(name)
    if (!entry) {
      if (force) return {}
      throw createFsError('ENOENT')
    }
    if (entry.kind === 'directory' && entry.children.size > 0 && !recursive) throw createFsError('ENOTEMPTY')
    parent.directory.children.delete(name)
    this.notifyWatchers(FS_OPERATIONS.rm, { path: path.href })
    return {}
  }

  private stat(args: Record<string, unknown>, authority: Readonly<FsAuthority>, follow: boolean) {
    const path = requirePath(read(args, 'path'), follow ? 'stat' : 'lstat')
    return this.statRecord(this.resolve(authority, path, follow, 'metadata').entry)
  }

  private symlink(args: Record<string, unknown>, authority: Readonly<FsAuthority>) {
    const target = requirePath(read(args, 'target'), 'symlink')
    const path = requirePath(read(args, 'path'), 'symlink')
    if (target.authority !== path.authority) throw createFsError('EXDEV')
    authorizeFsPath(authority, target, 'read', 'symlink')
    const parent = this.parent(authority, path, 'write').directory
    const name = path.segments.at(-1)
    if (!name) throw createFsError('EPERM')
    if (parent.children.has(name)) throw createFsError('EEXIST')
    this.assertEntryCapacity()
    this.assertDirectoryCapacity(parent, name)
    parent.children.set(name, {
      birthtimeMs: now(),
      ctimeMs: now(),
      kind: 'symlink',
      mode: 0o777,
      mtimeMs: now(),
      target
    })
    this.notifyWatchers(FS_OPERATIONS.symlink, { path: path.href })
    return {}
  }

  private openReadStream(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    authority: Readonly<FsAuthority>,
    sink: NativePortEventSink
  ) {
    const args = request.args as Record<string, unknown>
    const path = requirePath(read(args, 'path'), 'createReadStream')
    const start = requireInteger(read(args, 'start'), 0)
    const endExclusive = read(args, 'endExclusive') === null ? undefined : requireInteger(read(args, 'endExclusive'))
    const chunkSize = requireInteger(read(args, 'chunkSize'))
    if (chunkSize === 0 || chunkSize > this.#limits.maxChunkBytes) throw createFsError('EINVAL')
    const entry = this.resolve(authority, path, true, 'read').entry
    if (entry.kind !== 'file') throw createFsError(entry.kind === 'directory' ? 'EISDIR' : 'EINVAL')
    this.#streams.set(context.callToken, {
      callToken: context.callToken,
      chunkSize,
      cursor: Math.min(start, entry.data.byteLength),
      end: Math.min(endExclusive ?? entry.data.byteLength, entry.data.byteLength),
      file: entry,
      id: request.id,
      sequence: 0,
      sink
    })
  }

  private openWatcher(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    authority: Readonly<FsAuthority>,
    sink: NativePortEventSink
  ) {
    const path = requirePath((request.args as Record<string, unknown>).path, 'watch')
    this.resolve(authority, path, true, 'read')
    this.#watchers.set(context.callToken, {
      callToken: context.callToken,
      credits: 0,
      events: [],
      id: request.id,
      path,
      sequence: 0,
      sink
    })
  }

  private notifyWatchers(operation: string, args: Record<string, unknown>) {
    const candidates = [args.path, args.destination, args.source].filter(value => typeof value === 'string')
    for (const candidate of candidates) {
      let changed: ParsedFsPath
      try {
        changed = parseFsPath(candidate)
      } catch {
        continue
      }
      for (const watcher of this.#watchers.values()) {
        if (watcher.path.authority !== changed.authority) continue
        const prefix = watcher.path.segments
        if (!prefix.every((segment, index) => changed.segments[index] === segment)) continue
        if (watcher.events.length >= this.#limits.maxWatchEvents) {
          this.#watchers.delete(watcher.callToken)
          watcher.sink({ error: { code: 'limit_exceeded' }, id: watcher.id, type: 'error' })
          continue
        }
        watcher.events.push({
          eventType: operation === FS_OPERATIONS.chmod ? 'change' : 'rename',
          filename: changed.segments.slice(prefix.length).join('/')
        })
        this.flushWatcher(watcher)
      }
    }
  }

  private flushWatcher(watcher: WatchRecord) {
    while (watcher.credits > 0 && watcher.events.length > 0 && this.#watchers.has(watcher.callToken)) {
      const event = watcher.events.shift()!
      watcher.credits -= 1
      watcher.sink({ id: watcher.id, sequence: watcher.sequence++, ...fsSuccess(event), type: 'chunk' })
    }
  }

  private fileResource(
    args: Record<string, unknown>,
    context: Readonly<NativeDispatchContext>,
    authority: Readonly<FsAuthority>,
    permission: FsPermission
  ) {
    const reference = read(args, 'handle')
    const binding = context.resources.find(item => item.reference === reference && item.type === 'fs.file')
    if (!binding) throw createFsError('EBADF')
    const resource = this.#files.get(binding.providerToken)
    if (!resource || resource.owner !== binding.ownerCallToken) throw createFsError('EBADF')
    if (resource.authority !== resource.path.authority) throw createFsError('EBADF')
    const grant = authorizeFsPath(authority, resource.path, permission)
    if (grant.rootId !== resource.rootId) throw createFsError('EBADF')
    if ((permission === 'read' && !resource.readable) || (permission === 'write' && !resource.writable)) {
      throw createFsError('EACCES')
    }
    return resource
  }

  private atomicWriteResource(
    args: Record<string, unknown>,
    context: Readonly<NativeDispatchContext>,
    authority: Readonly<FsAuthority>
  ) {
    const reference = read(args, 'transaction')
    if (context.resources.length !== 1) throw createFsError('EBADF')
    const binding = context.resources[0]
    if (
      binding?.reference !== reference ||
      binding.type !== 'fs.atomic-write'
    ) {
      throw createFsError('EBADF')
    }
    const transaction = this.#transactions.get(binding.providerToken)
    if (
      transaction == null ||
      transaction.token !== binding.providerToken ||
      transaction.owner !== binding.ownerCallToken ||
      transaction.authority !== transaction.path.authority ||
      transaction.principal !== authority.principal ||
      !this.isActiveTransaction(transaction)
    ) {
      throw createFsError('EBADF')
    }
    const grant = authorizeFsPath(authority, transaction.path, 'write', 'writeFile')
    if (grant.rootId !== transaction.rootId) throw createFsError('EBADF')
    return transaction
  }

  private trackTransactionCall(
    transaction: AtomicWriteResource,
    callToken: NativeCallToken
  ) {
    transaction.callTokens.add(callToken)
    this.#transactionByCallToken.set(callToken, transaction.token)
  }

  private abortTransaction(transaction: AtomicWriteResource) {
    if (!this.isActiveTransaction(transaction)) return false
    transaction.state = 'aborted'
    transaction.entry.data = new Uint8Array()
    this.clearTransactionCalls(transaction)
    return true
  }

  private releaseTransaction(transaction: AtomicWriteResource) {
    this.clearTransactionCalls(transaction)
    this.#transactions.delete(transaction.token)
  }

  private clearTransactionCalls(transaction: AtomicWriteResource) {
    for (const callToken of transaction.callTokens) {
      if (this.#transactionByCallToken.get(callToken) === transaction.token) {
        this.#transactionByCallToken.delete(callToken)
      }
    }
    transaction.callTokens.clear()
  }

  private isActiveTransaction(transaction: AtomicWriteResource) {
    return transaction.state === 'open' || transaction.state === 'writing'
  }

  private allocateProviderToken(prefix: 'fs-atomic-write' | 'fs-file') {
    if (!Number.isSafeInteger(this.#nextToken)) throw createFsError('ENOSPC')
    const token = `${prefix}:${this.#nextToken}` as NativeProviderToken
    this.#nextToken += 1
    return token
  }

  private resolve(
    authority: Readonly<FsAuthority>,
    path: ParsedFsPath,
    follow: boolean,
    permission: FsPermission,
    hops = 0
  ): { entry: Entry; path: ParsedFsPath } {
    const grant = authorizeFsPath(authority, path, permission)
    let entry: Entry = this.root(grant)
    for (let index = 0; index < path.segments.length; index += 1) {
      if (entry.kind !== 'directory') throw createFsError('ENOTDIR')
      entry = entry.children.get(path.segments[index]!) ?? (() => {
        throw createFsError('ENOENT')
      })()
      if (entry.kind === 'symlink' && (follow || index < path.segments.length - 1)) {
        if (hops >= 40 || entry.target.authority !== path.authority) throw createFsError('EPERM')
        const next = formatFsPath(path.authority, [...entry.target.segments, ...path.segments.slice(index + 1)])
        return this.resolve(authority, parseFsPath(next), true, permission, hops + 1)
      }
    }
    return { entry, path }
  }

  private parent(authority: Readonly<FsAuthority>, path: ParsedFsPath, permission: FsPermission) {
    if (path.segments.length === 0) throw createFsError('EPERM')
    const parent = { ...path, segments: path.segments.slice(0, -1) }
    const result = this.resolve(authority, parent, true, permission)
    if (result.entry.kind !== 'directory') throw createFsError('ENOTDIR')
    return { directory: result.entry }
  }

  private root(grant: FsRootGrant) {
    let root = this.#roots.get(grant.rootId)
    if (!root) {
      root = directory()
      this.#roots.set(grant.rootId, root)
    }
    return root
  }

  private assertDirectoryCapacity(directory: DirectoryEntry, name: string) {
    if (!directory.children.has(name) && directory.children.size >= this.#limits.maxDirectoryEntries) {
      throw createFsError('ENOSPC')
    }
  }

  private statRecord(entry: Entry) {
    return {
      birthtimeMs: entry.birthtimeMs,
      ctimeMs: entry.ctimeMs,
      kind: entry.kind === 'directory' ? 'directory' : entry.kind === 'file' ? 'file' : 'symlink',
      mode: entry.mode,
      mtimeMs: entry.mtimeMs,
      size: entry.kind === 'file' ? entry.data.byteLength : 0
    }
  }

  private clone(entry: Entry): Entry {
    if (entry.kind === 'file') return { ...entry, data: new Uint8Array(entry.data) }
    if (entry.kind === 'symlink') return { ...entry, target: entry.target }
    const copied = directory(entry.mode)
    entry.children.forEach((child, name) => copied.children.set(name, this.clone(child)))
    return copied
  }

  private entrySize(entry: Entry): { bytes: number; entries: number } {
    if (entry.kind === 'file') return { bytes: entry.data.byteLength, entries: 1 }
    if (entry.kind === 'symlink') return { bytes: 0, entries: 1 }
    let bytes = 0
    let entries = 1
    entry.children.forEach(child => {
      const size = this.entrySize(child)
      bytes += size.bytes
      entries += size.entries
    })
    return { bytes, entries }
  }

  private releasedBytes(entry: Entry | undefined): number {
    if (entry == null) return 0
    if (entry.kind === 'file') {
      return this.isHeldFile(entry) ? 0 : entry.data.byteLength
    }
    if (entry.kind === 'symlink') return 0
    let bytes = 0
    entry.children.forEach(child => {
      bytes += this.releasedBytes(child)
    })
    return bytes
  }

  private isHeldFile(entry: FileEntry) {
    for (const resource of this.#files.values()) {
      if (resource.entry === entry) return true
    }
    return false
  }

  private assertEntryCapacity() {
    if (this.getSnapshot().entries >= this.#limits.maxEntries) throw createFsError('ENOSPC')
  }
  private totalBytes() {
    return this.getSnapshot().totalBytes
  }
  private canRead(resource: FileResource) {
    return resource.readable
  }
  private canWrite(resource: FileResource) {
    return resource.writable
  }
}
