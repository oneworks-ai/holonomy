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
  | 'create'
  | 'getattr'
  | 'lookup'
  | 'mkdir'
  | 'open'
  | 'read'
  | 'readdir'
  | 'release'
  | 'rename'
  | 'rmdir'
  | 'unlink'
  | 'write'

export interface LinuxFilesystemBridgeInputV1 {
  readonly bytes?: Uint8Array
  readonly environmentId: string
  readonly executableId: string
  readonly flags?: number
  readonly handle?: string
  readonly linuxPid: number
  readonly offset?: number
  readonly operation: LinuxFilesystemOperationV1
  readonly path: string
  readonly policy: ProcessSandboxV2
  readonly processId: number
  readonly processResourceId: string
  readonly scope: 'processTree' | 'runtime'
  readonly size?: number
  readonly toPath?: string
}

type KernelInvokeV1 = (input: Readonly<Record<string, unknown>>) => Promise<unknown>

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
    return await this.#invoke(Object.freeze({ ...request, source: linuxFilesystemSource(input) }))
  }

  async #dispatch(input: LinuxFilesystemBridgeInputV1): Promise<unknown> {
    const { mount, virtualUrl } = linuxMountedPath(input)
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
      return null
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
      return input.operation === 'create' ? { handle, kind: 'file', size: 0 } : handle
    }
    if (typeof input.handle !== 'string') throw linuxFilesystemFailure('Invalid filesystem handle', 9)
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
