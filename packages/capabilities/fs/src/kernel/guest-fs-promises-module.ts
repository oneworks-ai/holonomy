import type { CapabilityGuestBridgeV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import { capabilityTextPathV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import type { CapabilityFsFacadeCallsV1 } from './guest-fs-calls.js'
import { createCapabilityFileHandleV1 } from './guest-fs-file-handle.js'
import { createCapabilityFsWatchIteratorV1 } from './guest-fs-resources.js'
import {
  fsAccessModeV1,
  fsChmodModeV1,
  fsDirentsV1,
  fsLengthV1,
  fsMkdirResultV1,
  fsStatsV1,
  fsTargetV1,
  fsTimesV1
} from './guest-fs-support.js'

export const createCapabilityFsPromisesModuleV1 = (
  bridge: CapabilityGuestBridgeV1,
  calls: CapabilityFsFacadeCallsV1
) =>
  Object.freeze({
    access: async (path: unknown, mode?: unknown) => {
      const value = capabilityTextPathV1(path)
      await calls.promise('node:fs/promises', 'access', { path: value, mode: fsAccessModeV1(mode) }, { path: value })
    },
    chmod: async (path: unknown, mode: unknown) => {
      const value = capabilityTextPathV1(path)
      await calls.promise('node:fs/promises', 'chmod', { path: value, mode: fsChmodModeV1(mode) }, { path: value })
    },
    lstat: async (path: unknown, options?: unknown) =>
      fsStatsV1(await calls.pathCall('node:fs/promises', 'lstat', path, options, 'promise')),
    mkdir: async (path: unknown, options?: unknown) =>
      fsMkdirResultV1(await calls.pathCall('node:fs/promises', 'mkdir', path, options, 'promise')),
    open: (path: unknown, flag: unknown) => createCapabilityFileHandleV1(calls.promise.bind(calls), path, flag),
    readFile: (path: unknown, options?: unknown) => {
      const call = calls.readArgs(path, options, true)
      return calls.promise('node:fs/promises', 'readFile', call.args, call.fields, call.signal)
    },
    readdir: async (path: unknown, options?: unknown) =>
      fsDirentsV1(await calls.pathCall('node:fs/promises', 'readdir', path, options, 'promise')),
    rename: (from: unknown, to: unknown) => {
      const resolved = fsTargetV1(from)
      return calls.promise(
        'node:fs/promises',
        'rename',
        { from: resolved.value, to: capabilityTextPathV1(to) },
        resolved.fields
      )
    },
    stat: async (path: unknown, options?: unknown) =>
      fsStatsV1(await calls.pathCall('node:fs/promises', 'stat', path, options, 'promise')),
    truncate: async (path: unknown, len?: unknown) => {
      const value = capabilityTextPathV1(path)
      await calls.promise('node:fs/promises', 'truncate', { path: value, len: fsLengthV1(len) }, { path: value })
    },
    unlink: (path: unknown) => {
      const resolved = fsTargetV1(path)
      return calls.promise('node:fs/promises', 'unlink', { path: resolved.value }, resolved.fields)
    },
    utimes: async (path: unknown, atime: unknown, mtime: unknown) => {
      const value = capabilityTextPathV1(path)
      await calls.promise('node:fs/promises', 'utimes', { path: value, ...fsTimesV1(atime, mtime) }, { path: value })
    },
    watch: (path: unknown, options?: unknown) =>
      createCapabilityFsWatchIteratorV1(bridge, { sync: calls.sync.bind(calls) }, path, options),
    writeFile: (path: unknown, value: unknown, options?: unknown) => {
      const call = calls.writeArgs(path, value, options, true)
      return calls.promise('node:fs/promises', 'writeFile', call.args, call.fields, call.signal)
    }
  })
