import { capabilityResourceFieldsV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import type { CapabilityGuestAbortSignalV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import {
  fsChmodModeV1,
  fsDataV1,
  fsJsonObjectV1,
  fsLengthV1,
  fsReadOptionsV1,
  fsStatsV1,
  fsTargetV1,
  fsTimesV1,
  fsWriteOptionsV1,
  invalidFsValueV1
} from './guest-fs-support.js'
import type { FsCapabilityFieldsV1 } from './guest-fs-support.js'

export type FsPromiseCallV1 = (
  module: string,
  member: string,
  args: JsonValueV1,
  fields: FsCapabilityFieldsV1,
  signal?: CapabilityGuestAbortSignalV1
) => Promise<unknown>

export const createCapabilityFileHandleV1 = async (
  promise: FsPromiseCallV1,
  path: unknown,
  flag: unknown
) => {
  const resolved = fsTargetV1(path)
  if (typeof flag !== 'string') return invalidFsValueV1('Invalid file flag')
  const snapshot = await promise('node:fs/promises', 'open', { flag, path: resolved.value }, resolved.fields)
  const fields = capabilityResourceFieldsV1(snapshot, 'filesystem.file-handle')
  return Object.freeze({
    chmod: async (mode: unknown) => {
      await promise('node:fs/promises', 'FileHandle.chmod', { mode: fsChmodModeV1(mode) }, fields)
    },
    close: () => promise('node:fs/promises', 'FileHandle.close', {}, fields),
    datasync: async () => {
      await promise('node:fs/promises', 'FileHandle.datasync', {}, fields)
    },
    readFile: (options?: unknown) => {
      const prepared = fsReadOptionsV1(options, true)
      return promise(
        'node:fs/promises',
        'FileHandle.readFile',
        {
          options: prepared.options
        },
        fields,
        prepared.signal
      )
    },
    stat: async (options?: unknown) =>
      fsStatsV1(
        await promise(
          'node:fs/promises',
          'FileHandle.stat',
          options == null ? {} : fsJsonObjectV1(options),
          fields
        )
      ),
    sync: async () => {
      await promise('node:fs/promises', 'FileHandle.sync', {}, fields)
    },
    truncate: async (len?: unknown) => {
      await promise('node:fs/promises', 'FileHandle.truncate', { len: fsLengthV1(len) }, fields)
    },
    utimes: async (atime: unknown, mtime: unknown) => {
      await promise('node:fs/promises', 'FileHandle.utimes', fsTimesV1(atime, mtime), fields)
    },
    writeFile: (value: unknown, options?: unknown) => {
      const prepared = fsWriteOptionsV1(options, true)
      return promise(
        'node:fs/promises',
        'FileHandle.writeFile',
        {
          data: fsDataV1(value),
          options: prepared.options
        },
        fields,
        prepared.signal
      )
    }
  })
}
