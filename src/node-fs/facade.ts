/* eslint-disable max-lines -- the public facade keeps Node-style method binding and lifecycle in one owner. */

import { concatenateBytes, decodeBytes, toBytes } from './bytes.js'
import { FS_OPERATIONS, constants } from './constants.js'
import { closeResourceHandles, parseFsResourceResult, parseFsResultWithoutResources } from './contract.js'
import { createFsError, notSupported } from './errors.js'
import { MobileFsFileHandle } from './file-handle.js'
import { parseDirentRecords, parseStatRecord } from './metadata.js'
import { FsNativeClient } from './native-client.js'
import { normalizeMode, parseOpenFlags } from './open-flags.js'
import { assertSupportedOptions } from './options.js'
import { parseFsPath } from './path.js'
import { MobileFsReadStream } from './read-stream.js'
import { readResultInteger, readResultRecord, readResultString, readResultValue } from './result-validation.js'
import { MobileFsWatcher } from './watch-stream.js'

import type { NativeBridge, NativeResourceHandle } from '../native-port/types.js'
import type { FsDispatchOptions } from './native-client.js'
import type {
  FsCallOptions,
  FsCpOptions,
  FsDirent,
  FsFileHandle,
  FsMkdirOptions,
  FsOpenFlags,
  FsPromisesFacade,
  FsReadFileOptions,
  FsReadStream,
  FsReadStreamOptions,
  FsReaddirOptions,
  FsRmOptions,
  FsStats,
  FsWatcher,
  FsWriteFileOptions,
  NodeFsFacade,
  NodeFsFacadeOptions
} from './types.js'

const DEFAULT_CHUNK_BYTES = 64 * 1024
const DEFAULT_MAX_READ_FILE_BYTES = 64 * 1024 * 1024

const readPositiveLimit = (value: number | undefined, fallback: number) => {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw createFsError('EINVAL')
  }
  return resolved
}

export class MobileNodeFsFacade implements NodeFsFacade {
  readonly constants = constants
  readonly promises: FsPromisesFacade
  readonly #chunkBytes: number
  readonly #client: FsNativeClient
  readonly #handles = new Set<MobileFsFileHandle>()
  readonly #maxReadFileBytes: number
  readonly #now?: () => number
  readonly #streams = new Set<MobileFsReadStream>()
  readonly #transactions = new Set<NativeResourceHandle>()
  readonly #watchers = new Set<MobileFsWatcher>()
  #disposePromise?: Promise<void>
  #disposed = false

  constructor(bridge: NativeBridge, options: NodeFsFacadeOptions = {}) {
    options = assertSupportedOptions(
      options,
      ['chunkBytes', 'maxReadFileBytes', 'now'],
      'open'
    ) as NodeFsFacadeOptions
    this.#chunkBytes = readPositiveLimit(options.chunkBytes, DEFAULT_CHUNK_BYTES)
    this.#maxReadFileBytes = readPositiveLimit(
      options.maxReadFileBytes,
      DEFAULT_MAX_READ_FILE_BYTES
    )
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw createFsError('EINVAL', 'open')
    }
    this.#now = options.now
    this.#client = new FsNativeClient(bridge)
    this.promises = Object.freeze({
      access: this.access.bind(this),
      appendFile: this.appendFile.bind(this),
      chmod: this.chmod.bind(this),
      cp: this.cp.bind(this),
      lstat: this.lstat.bind(this),
      mkdir: this.mkdir.bind(this),
      open: this.open.bind(this),
      readFile: this.readFile.bind(this),
      readdir: this.readdir.bind(this),
      readlink: this.readlink.bind(this),
      realpath: this.realpath.bind(this),
      rename: this.rename.bind(this),
      rm: this.rm.bind(this),
      stat: this.stat.bind(this),
      symlink: this.symlink.bind(this),
      writeFile: this.writeFile.bind(this)
    }) as FsPromisesFacade
  }

  async access(path: string, mode = constants.F_OK, options: FsCallOptions = {}) {
    this.assertActive('access')
    options = assertSupportedOptions(options, ['signal', 'timeoutMs'], 'access') as FsCallOptions
    if (!Number.isSafeInteger(mode) || mode < 0 || (mode & ~7) !== 0) {
      throw createFsError('EINVAL', 'access')
    }
    parseFsResultWithoutResources(
      await this.#client.request(
        FS_OPERATIONS.access,
        { mode, path: parseFsPath(path, 'access').href },
        'access',
        options
      ),
      'access'
    )
  }

  async appendFile(
    path: string,
    data: string | ArrayBuffer | Uint8Array,
    options: FsWriteFileOptions = {}
  ) {
    options = assertSupportedOptions(
      options,
      ['encoding', 'flag', 'mode', 'signal', 'timeoutMs'],
      'appendFile'
    ) as FsWriteFileOptions
    await this.writeData(path, data, {
      ...options,
      flag: options.flag ?? 'a'
    }, 'appendFile')
  }

  async chmod(path: string, mode: number, options: FsCallOptions = {}) {
    this.assertActive('chmod')
    options = assertSupportedOptions(options, ['signal', 'timeoutMs'], 'chmod') as FsCallOptions
    parseFsResultWithoutResources(
      await this.#client.request(
        FS_OPERATIONS.chmod,
        {
          mode: normalizeMode(mode, 0, 'chmod'),
          path: parseFsPath(path, 'chmod').href
        },
        'chmod',
        options
      ),
      'chmod'
    )
  }

  async cp(
    source: string,
    destination: string,
    options: FsCpOptions = {}
  ) {
    this.assertActive('cp')
    options = assertSupportedOptions(
      options,
      ['errorOnExist', 'force', 'recursive', 'signal', 'timeoutMs'],
      'cp'
    ) as FsCpOptions
    parseFsResultWithoutResources(
      await this.#client.request(
        FS_OPERATIONS.cp,
        {
          destination: parseFsPath(destination, 'cp').href,
          errorOnExist: options.errorOnExist ?? false,
          force: options.force ?? true,
          recursive: options.recursive ?? false,
          source: parseFsPath(source, 'cp').href
        },
        'cp',
        options
      ),
      'cp'
    )
  }

  async lstat(path: string, options: FsCallOptions = {}) {
    return this.readStat(path, options, 'lstat')
  }

  async mkdir(path: string, options: FsMkdirOptions = {}) {
    this.assertActive('mkdir')
    options = assertSupportedOptions(
      options,
      ['mode', 'recursive', 'signal', 'timeoutMs'],
      'mkdir'
    ) as FsMkdirOptions
    const output = parseFsResultWithoutResources(
      await this.#client.request(
        FS_OPERATIONS.mkdir,
        {
          mode: normalizeMode(options.mode, 0o777, 'mkdir'),
          path: parseFsPath(path, 'mkdir').href,
          recursive: options.recursive ?? false
        },
        'mkdir',
        options
      ),
      'mkdir'
    )
    const record = readResultRecord(output.value, ['created'], 'mkdir')
    const created = readResultValue(record, 'created')
    if (created === null) return undefined
    if (typeof created !== 'string') throw createFsError('EIO', 'mkdir')
    return parseFsPath(created, 'mkdir').href
  }

  async open(
    path: string,
    flags: FsOpenFlags,
    mode = 0o666,
    options: FsCallOptions = {}
  ): Promise<FsFileHandle> {
    this.assertActive('open')
    options = assertSupportedOptions(options, ['signal', 'timeoutMs'], 'open') as FsCallOptions
    const parsedFlags = parseOpenFlags(flags)
    const output = parseFsResourceResult(
      await this.#client.request(
        FS_OPERATIONS.open,
        {
          flags: parsedFlags.numeric,
          mode: normalizeMode(mode, 0o666, 'open'),
          path: parseFsPath(path, 'open').href
        },
        'open',
        options
      ),
      'open'
    )
    if (
      output.resources == null ||
      output.resources.length !== 1 ||
      output.resources[0]?.type !== 'fs.file'
    ) {
      closeResourceHandles(output.resources, 'undeclared_fs_resource')
      throw createFsError('EIO', 'open')
    }
    const handle = new MobileFsFileHandle(
      this.#client,
      output.resources[0],
      this.#chunkBytes,
      closed => this.#handles.delete(closed)
    )
    if (this.#disposed) {
      await handle.close().catch(() => {})
      throw createFsError('EBADF', 'open')
    }
    this.#handles.add(handle)
    return handle
  }

  async readFile(
    path: string,
    options: FsReadFileOptions & { encoding: 'utf-8' | 'utf8' }
  ): Promise<string>
  async readFile(
    path: string,
    options?: FsReadFileOptions
  ): Promise<Uint8Array | string>
  async readFile(
    path: string,
    options: FsReadFileOptions = {}
  ) {
    this.assertActive('readFile')
    options = assertSupportedOptions(
      options,
      ['encoding', 'signal', 'timeoutMs'],
      'readFile'
    ) as FsReadFileOptions
    const stream = this.createReadStream(path, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    })
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    try {
      for await (const chunk of stream) {
        totalBytes += chunk.byteLength
        if (totalBytes > this.#maxReadFileBytes) {
          throw createFsError('ENOSPC', 'readFile')
        }
        chunks.push(chunk)
      }
    } finally {
      stream.close('read_file_complete')
    }
    return decodeBytes(
      concatenateBytes(chunks, totalBytes),
      options.encoding,
      'readFile'
    )
  }

  async readdir(
    path: string,
    options: FsReaddirOptions & { withFileTypes: true }
  ): Promise<FsDirent[]>
  async readdir(
    path: string,
    options?: FsReaddirOptions
  ): Promise<FsDirent[] | string[]>
  async readdir(
    path: string,
    options: FsReaddirOptions = {}
  ): Promise<FsDirent[] | string[]> {
    this.assertActive('readdir')
    options = assertSupportedOptions(
      options,
      ['encoding', 'signal', 'timeoutMs', 'withFileTypes'],
      'readdir'
    ) as FsReaddirOptions
    if (options.encoding != null && options.encoding !== 'utf8' && options.encoding !== 'utf-8') {
      throw createFsError('EINVAL', 'readdir')
    }
    const output = parseFsResultWithoutResources(
      await this.#client.request(
        FS_OPERATIONS.readdir,
        { path: parseFsPath(path, 'readdir').href },
        'readdir',
        options
      ),
      'readdir'
    )
    const record = readResultRecord(output.value, ['entries'], 'readdir')
    const entries = parseDirentRecords(readResultValue(record, 'entries'), 'readdir')
    return options.withFileTypes ? entries : entries.map(entry => entry.name)
  }

  async realpath(path: string, options: FsCallOptions = {}) {
    this.assertActive('realpath')
    options = assertSupportedOptions(options, ['signal', 'timeoutMs'], 'realpath') as FsCallOptions
    const output = parseFsResultWithoutResources(
      await this.#client.request(
        FS_OPERATIONS.realpath,
        { path: parseFsPath(path, 'realpath').href },
        'realpath',
        options
      ),
      'realpath'
    )
    const record = readResultRecord(output.value, ['path'], 'realpath')
    return parseFsPath(readResultString(record, 'path', 'realpath'), 'realpath').href
  }

  async readlink(path: string, options: FsCallOptions = {}) {
    this.assertActive('readlink')
    options = assertSupportedOptions(options, ['signal', 'timeoutMs'], 'readlink') as FsCallOptions
    const output = parseFsResultWithoutResources(
      await this.#client.request(
        FS_OPERATIONS.readlink,
        { path: parseFsPath(path, 'readlink').href },
        'readlink',
        options
      ),
      'readlink'
    )
    const record = readResultRecord(output.value, ['path'], 'readlink')
    return parseFsPath(readResultString(record, 'path', 'readlink'), 'readlink').href
  }

  async rename(
    oldPath: string,
    newPath: string,
    options: FsCallOptions = {}
  ) {
    this.assertActive('rename')
    options = assertSupportedOptions(options, ['signal', 'timeoutMs'], 'rename') as FsCallOptions
    const source = parseFsPath(oldPath, 'rename')
    const destination = parseFsPath(newPath, 'rename')
    if (source.authority !== destination.authority) {
      throw createFsError('EXDEV', 'rename')
    }
    parseFsResultWithoutResources(
      await this.#client.request(
        FS_OPERATIONS.rename,
        { destination: destination.href, source: source.href },
        'rename',
        options
      ),
      'rename'
    )
  }

  async rm(path: string, options: FsRmOptions = {}) {
    this.assertActive('rm')
    options = assertSupportedOptions(
      options,
      ['force', 'recursive', 'signal', 'timeoutMs'],
      'rm'
    ) as FsRmOptions
    parseFsResultWithoutResources(
      await this.#client.request(
        FS_OPERATIONS.rm,
        {
          force: options.force ?? false,
          path: parseFsPath(path, 'rm').href,
          recursive: options.recursive ?? false
        },
        'rm',
        options
      ),
      'rm'
    )
  }

  async stat(path: string, options: FsCallOptions = {}) {
    return this.readStat(path, options, 'stat')
  }

  async symlink(target: string, path: string, options: FsCallOptions = {}) {
    this.assertActive('symlink')
    options = assertSupportedOptions(options, ['signal', 'timeoutMs'], 'symlink') as FsCallOptions
    const targetPath = parseFsPath(target, 'symlink')
    const pathValue = parseFsPath(path, 'symlink')
    if (targetPath.authority !== pathValue.authority) {
      throw createFsError('EXDEV', 'symlink')
    }
    parseFsResultWithoutResources(
      await this.#client.request(
        FS_OPERATIONS.symlink,
        { path: pathValue.href, target: targetPath.href },
        'symlink',
        options
      ),
      'symlink'
    )
  }

  async writeFile(
    path: string,
    data: string | ArrayBuffer | Uint8Array,
    options: FsWriteFileOptions = {}
  ) {
    options = assertSupportedOptions(
      options,
      ['encoding', 'flag', 'mode', 'signal', 'timeoutMs'],
      'writeFile'
    ) as FsWriteFileOptions
    await this.writeData(path, data, {
      ...options,
      flag: options.flag ?? 'w'
    }, 'writeFile')
  }

  createReadStream(
    path: string,
    options: FsReadStreamOptions = {}
  ): FsReadStream {
    this.assertActive('createReadStream')
    options = assertSupportedOptions(
      options,
      ['end', 'highWaterMark', 'signal', 'start', 'timeoutMs'],
      'createReadStream'
    ) as FsReadStreamOptions
    const start = options.start ?? 0
    const end = options.end
    const chunkSize = options.highWaterMark ?? this.#chunkBytes
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      (end != null && (!Number.isSafeInteger(end) || end < start)) ||
      !Number.isSafeInteger(chunkSize) ||
      chunkSize <= 0 ||
      chunkSize > this.#chunkBytes
    ) {
      throw createFsError('EINVAL', 'createReadStream')
    }
    const endExclusive = end == null ? null : end + 1
    if (endExclusive != null && !Number.isSafeInteger(endExclusive)) {
      throw createFsError('EINVAL', 'createReadStream')
    }
    const nativeStream = this.#client.stream(
      FS_OPERATIONS.readStream,
      {
        chunkSize,
        endExclusive,
        path: parseFsPath(path, 'createReadStream').href,
        start
      },
      'createReadStream',
      options
    )
    const stream = new MobileFsReadStream(
      nativeStream,
      closed => this.#streams.delete(closed)
    )
    this.#streams.add(stream)
    return stream
  }

  createWriteStream(_path: string, _options?: FsWriteFileOptions): never {
    return notSupported('createWriteStream')
  }

  existsSync(_path: string): never {
    return notSupported('existsSync')
  }

  link(_existingPath: string, _newPath: string): never {
    return notSupported('link')
  }

  mkdtemp(_prefix: string): never {
    return notSupported('mkdtemp')
  }

  readFileSync(_path: string): never {
    return notSupported('readFileSync')
  }

  watch(path: string, options: FsCallOptions = {}): FsWatcher {
    this.assertActive('watch')
    options = assertSupportedOptions(options, ['signal', 'timeoutMs'], 'watch') as FsCallOptions
    const stream = this.#client.stream(
      FS_OPERATIONS.watch,
      { path: parseFsPath(path, 'watch').href },
      'watch',
      options
    )
    const watcher = new MobileFsWatcher(stream, closed => this.#watchers.delete(closed))
    this.#watchers.add(watcher)
    return watcher
  }

  dispose() {
    if (this.#disposePromise != null) return this.#disposePromise
    this.#disposed = true
    for (const stream of [...this.#streams]) stream.close('facade_dispose')
    for (const transaction of [...this.#transactions]) {
      transaction.close('facade_dispose')
    }
    this.#transactions.clear()
    for (const watcher of [...this.#watchers]) watcher.close('facade_dispose')
    this.#disposePromise = Promise.allSettled(
      [...this.#handles].map(handle => handle.close())
    ).then(() => {})
    return this.#disposePromise
  }

  private assertActive(syscall: Parameters<typeof createFsError>[1]) {
    if (this.#disposed) throw createFsError('EBADF', syscall)
  }

  private async readStat(
    path: string,
    options: FsCallOptions,
    syscall: 'lstat' | 'stat'
  ): Promise<FsStats> {
    this.assertActive(syscall)
    options = assertSupportedOptions(options, ['signal', 'timeoutMs'], syscall) as FsCallOptions
    const output = parseFsResultWithoutResources(
      await this.#client.request(
        syscall === 'stat' ? FS_OPERATIONS.stat : FS_OPERATIONS.lstat,
        { path: parseFsPath(path, syscall).href },
        syscall,
        options
      ),
      syscall
    )
    return parseStatRecord(output.value, syscall)
  }

  private async writeData(
    path: string,
    data: string | ArrayBuffer | Uint8Array,
    options: FsWriteFileOptions & { flag: FsOpenFlags },
    syscall: 'appendFile' | 'writeFile'
  ) {
    this.assertActive(syscall)
    const bytes = toBytes(data, options.encoding, syscall)
    const callOptions = this.createDispatchOptions(options, syscall)
    if (syscall === 'writeFile') {
      const flags = parseOpenFlags(options.flag, 'writeFile')
      if (!flags.truncate || flags.append || flags.directory || flags.exclusive) {
        return notSupported('writeFile')
      }
      return this.writeAtomic(
        parseFsPath(path, 'writeFile').href,
        bytes,
        flags.numeric,
        normalizeMode(options.mode, 0o666, 'writeFile'),
        callOptions
      )
    }
    await this.writeChunks(path, bytes, options.flag, options.mode ?? 0o666, callOptions, syscall)
  }

  private createDispatchOptions(
    options: FsCallOptions,
    syscall: 'appendFile' | 'writeFile'
  ): FsDispatchOptions {
    if (options.timeoutMs === undefined) {
      return Object.freeze({ ...(options.signal === undefined ? {} : { signal: options.signal }) })
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0 || this.#now == null) {
      throw createFsError(this.#now == null ? 'ERR_MOBILE_RUNTIME_NOT_SUPPORTED' : 'EINVAL', syscall)
    }
    let now: number
    try {
      now = this.#now()
    } catch {
      throw createFsError('EIO', syscall)
    }
    const deadlineMs = now + options.timeoutMs
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(deadlineMs)) {
      throw createFsError('EINVAL', syscall)
    }
    return Object.freeze({
      deadlineMs,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    })
  }

  private async writeAtomic(
    path: string,
    bytes: Uint8Array,
    flags: number,
    mode: number,
    callOptions: FsDispatchOptions
  ) {
    const begin = parseFsResourceResult(
      await this.#client.request(
        FS_OPERATIONS.atomicWriteBegin,
        { flags, mode, path },
        'writeFile',
        callOptions
      ),
      'writeFile'
    )
    if (
      begin.binary != null ||
      begin.value !== undefined ||
      begin.resources == null ||
      begin.resources.length !== 1 ||
      begin.resources[0]?.type !== 'fs.atomic-write'
    ) {
      closeResourceHandles(begin.resources, 'malformed_atomic_write_begin')
      throw createFsError('EIO', 'writeFile')
    }
    const transaction = begin.resources[0]
    if (this.#disposed) {
      transaction.close('facade_dispose')
      throw createFsError('EBADF', 'writeFile')
    }
    this.#transactions.add(transaction)
    let committed = false
    try {
      let offset = 0
      while (offset < bytes.byteLength) {
        if (callOptions.signal?.aborted === true) {
          throw createFsError('ECANCELED', 'writeFile')
        }
        const end = Math.min(bytes.byteLength, offset + this.#chunkBytes)
        const output = parseFsResultWithoutResources(
          await this.#client.request(
            FS_OPERATIONS.atomicWriteChunk,
            { transaction },
            'writeFile',
            callOptions,
            [{ data: bytes.subarray(offset, end), handle: 'data' }]
          ),
          'writeFile'
        )
        if (output.binary != null) throw createFsError('EIO', 'writeFile')
        const record = readResultRecord(output.value, ['bytesWritten'], 'writeFile')
        const bytesWritten = readResultInteger(record, 'bytesWritten', 'writeFile')
        if (bytesWritten <= 0 || bytesWritten > end - offset) {
          throw createFsError('EIO', 'writeFile')
        }
        offset += bytesWritten
      }
      const output = parseFsResultWithoutResources(
        await this.#client.request(
          FS_OPERATIONS.atomicWriteCommit,
          { transaction },
          'writeFile',
          callOptions
        ),
        'writeFile'
      )
      if (output.binary != null) throw createFsError('EIO', 'writeFile')
      readResultRecord(output.value, [], 'writeFile')
      committed = true
    } finally {
      this.#transactions.delete(transaction)
      transaction.close(committed ? 'atomic_write_committed' : 'atomic_write_aborted')
    }
  }

  private async writeChunks(
    path: string,
    bytes: Uint8Array,
    flags: FsOpenFlags,
    mode: number,
    callOptions: FsDispatchOptions,
    syscall: 'appendFile' | 'writeFile'
  ) {
    const handle = await this.openForDispatch(path, flags, mode, callOptions)
    let failure: unknown
    let failed = false
    try {
      let offset = 0
      while (offset < bytes.byteLength) {
        if (callOptions.signal?.aborted === true) {
          throw createFsError('ECANCELED', syscall)
        }
        const result = await handle.writeForDispatch(
          bytes,
          offset,
          Math.min(this.#chunkBytes, bytes.byteLength - offset),
          null,
          callOptions
        )
        if (result.bytesWritten <= 0) throw createFsError('EIO', syscall)
        offset += result.bytesWritten
      }
    } catch (error) {
      failed = true
      failure = error
    }
    try {
      await handle.close()
    } catch (closeError) {
      if (!failed) throw closeError
    }
    if (failed) throw failure
  }

  private async openForDispatch(
    path: string,
    flags: FsOpenFlags,
    mode: number,
    options: FsDispatchOptions
  ): Promise<MobileFsFileHandle> {
    const parsedFlags = parseOpenFlags(flags)
    const output = parseFsResourceResult(
      await this.#client.request(
        FS_OPERATIONS.open,
        {
          flags: parsedFlags.numeric,
          mode: normalizeMode(mode, 0o666, 'open'),
          path: parseFsPath(path, 'open').href
        },
        'open',
        options
      ),
      'open'
    )
    if (
      output.resources == null ||
      output.resources.length !== 1 ||
      output.resources[0]?.type !== 'fs.file'
    ) {
      closeResourceHandles(output.resources, 'undeclared_fs_resource')
      throw createFsError('EIO', 'open')
    }
    const handle = new MobileFsFileHandle(
      this.#client,
      output.resources[0],
      this.#chunkBytes,
      closed => this.#handles.delete(closed)
    )
    if (this.#disposed) {
      await handle.close().catch(() => {})
      throw createFsError('EBADF', 'open')
    }
    this.#handles.add(handle)
    return handle
  }
}

export const createNodeFsFacade = (
  bridge: NativeBridge,
  options?: NodeFsFacadeOptions
) => new MobileNodeFsFacade(bridge, options)
