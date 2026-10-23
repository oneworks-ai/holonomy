/* eslint-disable max-lines -- Linux FUSE operations share one attributed Broker boundary. */
import type { ProcessSandboxV2 } from '@holonomyjs/capability-process/kernel/policy-process-types'
import {
  decodeLinuxFilesystemData,
  encodeLinuxFilesystemData,
  linuxFilesystemErrno,
  linuxFilesystemFailure,
  linuxFilesystemSource,
  linuxMountedPath,
  linuxOpenFlag,
  requireLinuxFilesystemRight
} from './linux-filesystem-bridge-support.js'

type LinuxFilesystemOperationV1 =
  | 'access'
  | 'create'
  | 'fsync'
  | 'fsyncdir'
  | 'getattr'
  | 'lookup'
  | 'mkdir'
  | 'open'
  | 'opendir'
  | 'read'
  | 'readdir'
  | 'release'
  | 'releasedir'
  | 'rename'
  | 'rmdir'
  | 'setattr'
  | 'unlink'
  | 'write'

export interface LinuxFilesystemBridgeInputV1 {
  readonly atime?: LinuxFilesystemTimeV1
  readonly bytes?: Uint8Array
  readonly datasync?: boolean
  readonly environmentId: string
  readonly executableId: string
  readonly flags?: number
  readonly handle?: string
  readonly handleKind?: 'file' | 'directory'
  readonly linuxPid: number
  readonly mask?: number
  readonly mode?: number
  readonly mtime?: LinuxFilesystemTimeV1
  readonly expectedKind?: 'file' | 'directory'
  readonly offset?: number
  readonly operation: LinuxFilesystemOperationV1
  readonly path: string
  readonly policy: ProcessSandboxV2
  readonly processId: number
  readonly processResourceId: string
  readonly scope: 'processTree' | 'runtime'
  readonly size?: number
  readonly signal?: AbortSignal
  readonly toPath?: string
}

export type LinuxFilesystemTimeV1 =
  | Readonly<{ kind: 'set'; seconds: number; nanoseconds: number }>
  | Readonly<{ kind: 'now' }>
  | Readonly<{ kind: 'omit' }>

type KernelInvokeV1 = (input: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<unknown>

export class LinuxFilesystemCapabilityBridgeV1 {
  #invoke?: KernelInvokeV1

  bind(invoke: KernelInvokeV1): this {
    if (this.#invoke != null || typeof invoke !== 'function') throw new TypeError('Invalid Linux filesystem binding')
    this.#invoke = invoke
    return this
  }

  async dispatch(input: LinuxFilesystemBridgeInputV1): Promise<unknown> {
    try {
      return await this.#dispatch(input)
    } catch (error) {
      throw linuxFilesystemFailure(
        (error as { message?: string })?.message ?? 'Linux filesystem invocation failed',
        linuxFilesystemErrno(error),
        typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : undefined
      )
    }
  }

  async #call(input: LinuxFilesystemBridgeInputV1, request: Readonly<Record<string, unknown>>) {
    if (this.#invoke == null) throw linuxFilesystemFailure('Linux filesystem bridge is not bound', 13)
    return await this.#invoke(Object.freeze({ ...request, source: linuxFilesystemSource(input) }), input.signal)
  }

  async #dispatch(input: LinuxFilesystemBridgeInputV1): Promise<unknown> {
    const { mount, virtualUrl } = linuxMountedPath(input)
    if (input.operation === 'access') {
      if (!Number.isInteger(input.mask) || input.mask! < 0 || input.mask! > 7) {
        throw linuxFilesystemFailure('Invalid access mask', 22)
      }
      if (input.mask === 0 || input.mask! & 4 || input.mask! & 1) requireLinuxFilesystemRight(mount, 'read')
      if (input.mask! & 2) requireLinuxFilesystemRight(mount, 'write')
      await this.#call(input, {
        arguments: { path: virtualUrl, mode: input.mask },
        member: 'access',
        mode: 'promise',
        module: 'node:fs/promises',
        path: virtualUrl
      })
      return null
    }
    if (input.operation === 'fsyncdir') {
      requireLinuxFilesystemRight(mount, 'read')
      if (typeof input.datasync !== 'boolean' || typeof input.handle !== 'string') {
        throw linuxFilesystemFailure('Invalid directory sync request', 22)
      }
      await this.#call(input, {
        arguments: { dataOnly: input.datasync },
        bindingId: input.handle,
        member: 'directory.sync',
        mode: 'promise',
        module: 'host.fs',
        resourceType: 'filesystem.directory-handle'
      })
      return null
    }
    if (input.operation === 'opendir') {
      requireLinuxFilesystemRight(mount, 'read')
      const result = await this.#call(input, {
        arguments: { path: virtualUrl },
        member: 'directory.open',
        mode: 'promise',
        module: 'host.fs',
        path: virtualUrl
      })
      const opened = result as { binding?: { bindingId?: unknown }; entries?: unknown }
      if (typeof opened?.binding?.bindingId !== 'string' || !Array.isArray(opened.entries)) {
        throw linuxFilesystemFailure('Invalid directory handle', 5)
      }
      return { handle: opened.binding.bindingId, entries: opened.entries }
    }
    if (input.operation === 'setattr') {
      requireLinuxFilesystemRight(mount, 'write')
      if (input.handle != null && typeof input.handle !== 'string') {
        throw linuxFilesystemFailure('Invalid filesystem handle', 9)
      }
      const byHandle = typeof input.handle === 'string'
      const size = input.size
      const times = input.atime != null || input.mtime != null
      const modeChange = input.mode != null
      if (Number(size != null) + Number(times) + Number(modeChange) !== 1) {
        throw linuxFilesystemFailure('Unsupported combined setattr', 95)
      }
      if (modeChange) {
        if (!Number.isSafeInteger(input.mode) || input.mode! < 0 || input.mode! > 0o777) {
          throw linuxFilesystemFailure('Invalid chmod mode', 22)
        }
        if (input.expectedKind != null && !['file', 'directory'].includes(input.expectedKind)) {
          throw linuxFilesystemFailure('Invalid chmod expected kind', 22)
        }
        if (
          byHandle && !['file', 'directory'].includes(input.handleKind as string) ||
          byHandle && input.expectedKind != null && input.expectedKind !== input.handleKind ||
          !byHandle && input.handleKind != null
        ) throw linuxFilesystemFailure('Invalid chmod handle kind', 22)
        const directoryHandle = byHandle && input.handleKind === 'directory'
        return await this.#call(input, {
          arguments: {
            ...(byHandle ? {} : { path: virtualUrl }),
            mode: input.mode,
            readback: true,
            ...(input.expectedKind == null ? {} : { expectedKind: input.expectedKind })
          },
          ...(byHandle
            ? {
              bindingId: input.handle,
              resourceType: directoryHandle ? 'filesystem.directory-handle' : 'filesystem.file-handle'
            }
            : { path: virtualUrl }),
          member: directoryHandle ? 'directory.chmod' : byHandle ? 'FileHandle.chmod' : 'chmod',
          mode: 'promise',
          module: directoryHandle ? 'host.fs' : 'node:fs/promises'
        })
      }
      if (input.expectedKind != null) throw linuxFilesystemFailure('Unexpected chmod expected kind', 22)
      const member = size != null
        ? byHandle ? 'FileHandle.truncate' : 'truncate'
        : byHandle
        ? 'FileHandle.utimes'
        : 'utimes'
      const argumentsValue = size != null
        ? { ...(byHandle ? {} : { path: virtualUrl }), len: size, readback: true }
        : {
          ...(byHandle ? {} : { path: virtualUrl }),
          atime: input.atime ?? { kind: 'omit' },
          mtime: input.mtime ?? { kind: 'omit' },
          readback: true
        }
      return await this.#call(input, {
        arguments: argumentsValue,
        ...(byHandle ? { bindingId: input.handle, resourceType: 'filesystem.file-handle' } : { path: virtualUrl }),
        member,
        mode: 'promise',
        module: 'node:fs/promises'
      })
    }
    if (input.operation === 'lookup' || input.operation === 'getattr') {
      requireLinuxFilesystemRight(mount, 'read')
      return await this.#call(input, {
        arguments: { path: virtualUrl },
        member: 'stat',
        mode: 'promise',
        module: 'node:fs/promises',
        path: virtualUrl
      })
    }
    if (input.operation === 'readdir') {
      requireLinuxFilesystemRight(mount, 'read')
      return await this.#call(input, {
        arguments: { options: { withFileTypes: true }, path: virtualUrl },
        member: 'readdir',
        mode: 'promise',
        module: 'node:fs/promises',
        path: virtualUrl
      })
    }
    if (input.operation === 'mkdir') {
      requireLinuxFilesystemRight(mount, 'write')
      await this.#call(input, {
        arguments: { options: { recursive: false }, path: virtualUrl },
        member: 'mkdir',
        mode: 'promise',
        module: 'node:fs/promises',
        path: virtualUrl
      })
      return await this.#call(input, {
        arguments: { path: virtualUrl },
        member: 'stat',
        mode: 'promise',
        module: 'node:fs/promises',
        path: virtualUrl
      })
    }
    if (input.operation === 'unlink' || input.operation === 'rmdir') {
      requireLinuxFilesystemRight(mount, 'write')
      await this.#call(input, {
        arguments: { path: virtualUrl },
        member: 'unlink',
        mode: 'promise',
        module: 'node:fs/promises',
        path: virtualUrl,
        ...(input.operation === 'rmdir' ? { providerData: { kind: 'directoryRemove' } } : {})
      })
      return null
    }
    if (input.operation === 'rename') {
      requireLinuxFilesystemRight(mount, 'write')
      if (typeof input.toPath !== 'string') throw linuxFilesystemFailure('Invalid rename destination')
      const destination = linuxMountedPath({ ...input, path: input.toPath })
      requireLinuxFilesystemRight(destination.mount, 'write')
      await this.#call(input, {
        arguments: { from: virtualUrl, to: destination.virtualUrl },
        member: 'rename',
        mode: 'promise',
        module: 'node:fs/promises',
        path: virtualUrl
      })
      return null
    }
    if (input.operation === 'open' || input.operation === 'create') {
      const opened = linuxOpenFlag(input.flags ?? -1)
      for (const right of opened.rights) requireLinuxFilesystemRight(mount, right)
      if (input.operation === 'create') requireLinuxFilesystemRight(mount, 'write')
      const result = await this.#call(input, {
        arguments: { flag: opened.flag, path: virtualUrl },
        member: 'open',
        mode: 'promise',
        module: 'node:fs/promises',
        path: virtualUrl
      })
      const handle = (result as { binding?: { bindingId?: unknown } })?.binding?.bindingId
      if (typeof handle !== 'string') throw linuxFilesystemFailure('Invalid filesystem handle')
      if (input.operation === 'create') {
        const metadata = await this.#call(input, {
          arguments: {},
          bindingId: handle,
          member: 'FileHandle.stat',
          mode: 'promise',
          module: 'node:fs/promises',
          resourceType: 'filesystem.file-handle'
        })
        return { ...(metadata as Record<string, unknown>), handle }
      }
      return handle
    }
    if (typeof input.handle !== 'string') throw linuxFilesystemFailure('Invalid filesystem handle', 9)
    if (input.operation === 'releasedir') {
      await this.#call(input, {
        arguments: {},
        bindingId: input.handle,
        member: 'directory.close',
        mode: 'promise',
        module: 'host.fs',
        resourceType: 'filesystem.directory-handle'
      })
      return null
    }
    if (input.operation === 'fsync') {
      if (typeof input.datasync !== 'boolean') throw linuxFilesystemFailure('Invalid file sync mode', 22)
      await this.#call(input, {
        arguments: {},
        bindingId: input.handle,
        member: input.datasync ? 'FileHandle.datasync' : 'FileHandle.sync',
        mode: 'promise',
        module: 'node:fs/promises',
        resourceType: 'filesystem.file-handle'
      })
      return null
    }
    if (input.operation === 'release') {
      await this.#call(input, {
        arguments: {},
        bindingId: input.handle,
        member: 'FileHandle.close',
        mode: 'promise',
        module: 'node:fs/promises',
        resourceType: 'filesystem.file-handle'
      })
      return null
    }
    if (input.operation === 'read') {
      requireLinuxFilesystemRight(mount, 'read')
      return decodeLinuxFilesystemData(
        await this.#call(input, {
          arguments: {},
          bindingId: input.handle,
          member: 'FileHandle.readFile',
          mode: 'promise',
          module: 'node:fs/promises',
          providerData: { kind: 'positionedRead', offset: input.offset, size: input.size },
          resourceType: 'filesystem.file-handle'
        })
      )
    }
    if (input.operation === 'write' && input.bytes instanceof Uint8Array) {
      requireLinuxFilesystemRight(mount, 'write')
      await this.#call(input, {
        arguments: { data: encodeLinuxFilesystemData(input.bytes) },
        bindingId: input.handle,
        member: 'FileHandle.writeFile',
        mode: 'promise',
        module: 'node:fs/promises',
        providerData: { kind: 'positionedWrite', offset: input.offset },
        resourceType: 'filesystem.file-handle'
      })
      return input.bytes.byteLength
    }
    throw linuxFilesystemFailure('Unsupported Linux filesystem operation', 38)
  }
}
