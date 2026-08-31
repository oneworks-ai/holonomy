/* eslint-disable max-lines -- public FS facade, authority and provider records form one reviewed API inventory. */

import type { constants } from './constants.js'

export type FsRootAuthority = 'app-data' | 'temp' | 'workspace'
export type FsPermission = 'metadata' | 'read' | 'write'

export type FsErrorCode =
  | 'EACCES'
  | 'EBADF'
  | 'ECANCELED'
  | 'EEXIST'
  | 'EINVAL'
  | 'EIO'
  | 'EISDIR'
  | 'ENOENT'
  | 'ENOSPC'
  | 'ENOTDIR'
  | 'ENOTEMPTY'
  | 'EPERM'
  | 'ERR_HOLONOMY_NOT_SUPPORTED'
  | 'ETIMEDOUT'
  | 'EXDEV'

export type FsOperationName =
  | 'access'
  | 'appendFile'
  | 'chmod'
  | 'close'
  | 'cp'
  | 'createReadStream'
  | 'createWriteStream'
  | 'existsSync'
  | 'link'
  | 'lstat'
  | 'mkdir'
  | 'mkdtemp'
  | 'open'
  | 'read'
  | 'readFile'
  | 'readFileSync'
  | 'readdir'
  | 'readlink'
  | 'realpath'
  | 'rename'
  | 'rm'
  | 'stat'
  | 'symlink'
  | 'sync'
  | 'watch'
  | 'write'
  | 'writeFile'

export interface FsRootGrantInput {
  /** Provider-private allocation id. It is never serialized into a guest request. */
  rootId: string
  permissions: readonly FsPermission[]
}

export interface FsAuthorityInput {
  capabilities: readonly string[]
  principal: string
  roots: Partial<Record<FsRootAuthority, FsRootGrantInput>>
}

export interface FsRootGrant {
  readonly rootId: string
  readonly permissions: readonly FsPermission[]
}

export interface FsAuthority {
  readonly capabilities: readonly string[]
  readonly principal: string
  readonly roots: Readonly<Partial<Record<FsRootAuthority, FsRootGrant>>>
}

export interface ParsedFsPath {
  readonly authority: FsRootAuthority
  readonly href: string
  readonly segments: readonly string[]
}

export interface FsCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export type FsEncoding = 'utf-8' | 'utf8'

export interface FsReadFileOptions extends FsCallOptions {
  encoding?: FsEncoding | null
}

export interface FsWriteFileOptions extends FsCallOptions {
  encoding?: FsEncoding
  flag?: FsOpenFlags
  mode?: number
}

export interface FsMkdirOptions extends FsCallOptions {
  mode?: number
  recursive?: boolean
}

export interface FsReaddirOptions extends FsCallOptions {
  encoding?: FsEncoding
  withFileTypes?: boolean
}

export interface FsRmOptions extends FsCallOptions {
  force?: boolean
  recursive?: boolean
}

export interface FsCpOptions extends FsCallOptions {
  errorOnExist?: boolean
  force?: boolean
  recursive?: boolean
}

export interface FsReadStreamOptions extends FsCallOptions {
  end?: number
  highWaterMark?: number
  start?: number
}

export type FsStringOpenFlags =
  | 'a'
  | 'a+'
  | 'ax'
  | 'ax+'
  | 'r'
  | 'r+'
  | 'w'
  | 'w+'
  | 'wx'
  | 'wx+'

export type FsOpenFlags = FsStringOpenFlags | number

export interface FsOpenOptions extends FsCallOptions {
  mode?: number
}

export interface FsStats {
  readonly birthtimeMs: number
  readonly ctimeMs: number
  readonly mode: number
  readonly mtimeMs: number
  readonly size: number
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface FsDirent {
  readonly name: string
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface FsFileReadResult<TBuffer extends Uint8Array = Uint8Array> {
  buffer: TBuffer
  bytesRead: number
}

export interface FsFileWriteResult<TBuffer extends Uint8Array = Uint8Array> {
  buffer: TBuffer
  bytesWritten: number
}

export interface FsFileHandle {
  readonly isClosed: boolean
  close(): Promise<void>
  dispose(): Promise<void>
  read<TBuffer extends Uint8Array>(
    buffer: TBuffer,
    offset?: number,
    length?: number,
    position?: number | null,
    options?: FsCallOptions
  ): Promise<FsFileReadResult<TBuffer>>
  stat(options?: FsCallOptions): Promise<FsStats>
  sync(options?: FsCallOptions): Promise<void>
  write<TBuffer extends Uint8Array>(
    buffer: TBuffer,
    offset?: number,
    length?: number,
    position?: number | null,
    options?: FsCallOptions
  ): Promise<FsFileWriteResult<TBuffer>>
}

export interface FsReadStream extends AsyncIterableIterator<Uint8Array> {
  readonly isClosed: boolean
  close(reason?: string): boolean
}

export interface FsWatchEvent {
  eventType: 'change' | 'rename'
  filename: string
}

export interface FsWatcher extends AsyncIterableIterator<FsWatchEvent> {
  readonly isClosed: boolean
  close(reason?: string): boolean
}

export interface FsPromisesFacade {
  access(path: string, mode?: number, options?: FsCallOptions): Promise<void>
  appendFile(path: string, data: string | ArrayBuffer | Uint8Array, options?: FsWriteFileOptions): Promise<void>
  chmod(path: string, mode: number, options?: FsCallOptions): Promise<void>
  cp(source: string, destination: string, options?: FsCpOptions): Promise<void>
  lstat(path: string, options?: FsCallOptions): Promise<FsStats>
  mkdir(path: string, options?: FsMkdirOptions): Promise<string | undefined>
  open(path: string, flags: FsOpenFlags, mode?: number, options?: FsCallOptions): Promise<FsFileHandle>
  readFile(path: string, options: FsReadFileOptions & { encoding: FsEncoding }): Promise<string>
  readFile(path: string, options?: FsReadFileOptions): Promise<Uint8Array | string>
  readdir(path: string, options: FsReaddirOptions & { withFileTypes: true }): Promise<FsDirent[]>
  readdir(path: string, options?: FsReaddirOptions): Promise<FsDirent[] | string[]>
  readlink(path: string, options?: FsCallOptions): Promise<string>
  realpath(path: string, options?: FsCallOptions): Promise<string>
  rename(oldPath: string, newPath: string, options?: FsCallOptions): Promise<void>
  rm(path: string, options?: FsRmOptions): Promise<void>
  stat(path: string, options?: FsCallOptions): Promise<FsStats>
  symlink(target: string, path: string, options?: FsCallOptions): Promise<void>
  writeFile(path: string, data: string | ArrayBuffer | Uint8Array, options?: FsWriteFileOptions): Promise<void>
}

export interface NodeFsFacade {
  readonly constants: typeof constants
  readonly promises: FsPromisesFacade
  createReadStream(path: string, options?: FsReadStreamOptions): FsReadStream
  createWriteStream(path: string, options?: FsWriteFileOptions): never
  dispose(): Promise<void>
  existsSync(path: string): never
  link(existingPath: string, newPath: string): never
  mkdtemp(prefix: string): never
  readFileSync(path: string): never
  readlink(path: string, options?: FsCallOptions): Promise<string>
  symlink(target: string, path: string, options?: FsCallOptions): Promise<void>
  watch(path: string, options?: FsCallOptions): FsWatcher
}

export interface NodeFsFacadeOptions {
  chunkBytes?: number
  maxReadFileBytes?: number
  /** Host-injected monotonic clock in the V4 EventLoop time domain. */
  now?: () => number
}

export interface FsStatRecord {
  birthtimeMs: number
  ctimeMs: number
  kind: 'directory' | 'file' | 'symlink'
  mode: number
  mtimeMs: number
  size: number
}

export interface FsDirentRecord {
  kind: 'directory' | 'file' | 'symlink'
  name: string
}

export interface MemoryFsLimits {
  maxChunkBytes: number
  maxDirectoryEntries: number
  maxEntries: number
  maxFileBytes: number
  maxOpenHandles: number
  maxTotalBytes: number
  maxWatchEvents: number
}

export interface MemoryFsProviderSnapshot {
  disposed: boolean
  entries: number
  openHandles: number
  pendingTransactions: number
  pendingStreams: number
  totalBytes: number
  transactionBytes: number
}
