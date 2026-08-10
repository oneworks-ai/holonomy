import { FS_OPERATIONS } from './constants.js'
import { parseFsResultWithoutResources, readSingleBinary } from './contract.js'
import { createFsError } from './errors.js'
import { parseStatRecord } from './metadata.js'
import { assertSupportedOptions } from './options.js'
import { readResultInteger, readResultRecord } from './result-validation.js'

import type { NativeResourceHandle } from '../native-port/types.js'
import type { FsDispatchOptions, FsNativeClient } from './native-client.js'
import type { FsCallOptions, FsFileHandle, FsFileReadResult, FsFileWriteResult } from './types.js'

const readRange = (
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
  syscall: 'read' | 'write'
) => {
  if (
    !(buffer instanceof Uint8Array) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    offset + length > buffer.byteLength ||
    (position !== null && (!Number.isSafeInteger(position) || position < 0))
  ) {
    throw createFsError('EINVAL', syscall)
  }
}

export class HolonomyFsFileHandle implements FsFileHandle {
  #closePromise?: Promise<void>
  #closed = false

  constructor(
    private readonly client: FsNativeClient,
    private readonly resource: NativeResourceHandle,
    private readonly chunkBytes: number,
    private readonly onClose: (handle: HolonomyFsFileHandle) => void
  ) {}

  get isClosed() {
    return this.#closed
  }

  close() {
    if (this.#closePromise != null) return this.#closePromise
    this.#closed = true
    this.#closePromise = Promise.resolve().then(() => {
      if (!this.resource.close('file_close')) throw createFsError('EBADF', 'close')
    }).finally(() => {
      this.onClose(this)
    })
    return this.#closePromise
  }

  dispose() {
    return this.close()
  }

  async read<TBuffer extends Uint8Array>(
    buffer: TBuffer,
    offset = 0,
    length = buffer.byteLength - offset,
    position: number | null = null,
    options: FsCallOptions = {}
  ): Promise<FsFileReadResult<TBuffer>> {
    this.assertOpen('read')
    options = assertSupportedOptions(options, ['signal', 'timeoutMs'], 'read') as FsCallOptions
    readRange(buffer, offset, length, position, 'read')
    const requested = Math.min(length, this.chunkBytes)
    const output = parseFsResultWithoutResources(
      await this.client.request(
        FS_OPERATIONS.handleRead,
        { ...this.callArgs(), length: requested, position },
        'read',
        options
      ),
      'read'
    )
    const record = readResultRecord(output.value, ['bytesRead'], 'read')
    const bytesRead = readResultInteger(record, 'bytesRead', 'read')
    const bytes = readSingleBinary(output.binary, 'read')
    if (bytesRead > requested || bytes.byteLength !== bytesRead) {
      throw createFsError('EIO', 'read')
    }
    buffer.set(bytes, offset)
    return { buffer, bytesRead }
  }

  async stat(options: FsCallOptions = {}) {
    this.assertOpen('stat')
    options = assertSupportedOptions(options, ['signal', 'timeoutMs'], 'stat') as FsCallOptions
    const output = parseFsResultWithoutResources(
      await this.client.request(
        FS_OPERATIONS.handleStat,
        this.callArgs(),
        'stat',
        options
      ),
      'stat'
    )
    return parseStatRecord(output.value, 'stat')
  }

  async sync(options: FsCallOptions = {}) {
    this.assertOpen('sync')
    options = assertSupportedOptions(options, ['signal', 'timeoutMs'], 'sync') as FsCallOptions
    parseFsResultWithoutResources(
      await this.client.request(
        FS_OPERATIONS.handleSync,
        this.callArgs(),
        'sync',
        options
      ),
      'sync'
    )
  }

  async write<TBuffer extends Uint8Array>(
    buffer: TBuffer,
    offset = 0,
    length = buffer.byteLength - offset,
    position: number | null = null,
    options: FsCallOptions = {}
  ): Promise<FsFileWriteResult<TBuffer>> {
    this.assertOpen('write')
    options = assertSupportedOptions(options, ['signal', 'timeoutMs'], 'write') as FsCallOptions
    return this.writeForDispatch(buffer, offset, length, position, options)
  }

  async writeForDispatch<TBuffer extends Uint8Array>(
    buffer: TBuffer,
    offset: number,
    length: number,
    position: number | null,
    options: FsDispatchOptions
  ): Promise<FsFileWriteResult<TBuffer>> {
    this.assertOpen('write')
    readRange(buffer, offset, length, position, 'write')
    const requested = Math.min(length, this.chunkBytes)
    const bytes = buffer.slice(offset, offset + requested)
    const output = parseFsResultWithoutResources(
      await this.client.request(
        FS_OPERATIONS.handleWrite,
        { ...this.callArgs(), position },
        'write',
        options,
        [{ data: bytes, handle: 'data' }]
      ),
      'write'
    )
    const record = readResultRecord(output.value, ['bytesWritten'], 'write')
    const bytesWritten = readResultInteger(record, 'bytesWritten', 'write')
    if (bytesWritten > requested) throw createFsError('EIO', 'write')
    return { buffer, bytesWritten }
  }

  private assertOpen(syscall: 'read' | 'stat' | 'sync' | 'write') {
    if (this.#closed) throw createFsError('EBADF', syscall)
  }

  private callArgs() {
    return { handle: this.resource }
  }
}
