import type { CapabilityGuestBridgeV1 } from './guest-facade-support.js'
import { capabilityTextPathV1 } from './guest-facade-support.js'
import type { CapabilityFsFacadeCallsV1 } from './guest-fs-calls.js'
import { createCapabilityFileHandleV1 } from './guest-fs-file-handle.js'
import { createCapabilityFsWatchIteratorV1 } from './guest-fs-resources.js'
import { fsDirentsV1, fsMkdirResultV1, fsStatsV1, fsTargetV1 } from './guest-fs-support.js'

export const createCapabilityFsPromisesModuleV1 = (
  bridge: CapabilityGuestBridgeV1,
  calls: CapabilityFsFacadeCallsV1
) =>
  Object.freeze({
    lstat: async (path: unknown, options?: unknown) =>
      fsStatsV1(await calls.pathCall('node:fs/promises', 'lstat', path, options, 'promise')),
    mkdir: async (path: unknown, options?: unknown) =>
      fsMkdirResultV1(await calls.pathCall('node:fs/promises', 'mkdir', path, options, 'promise')),
    open: (path: unknown, flag: unknown) => createCapabilityFileHandleV1(calls.promise.bind(calls), path, flag),
    readFile: (path: unknown, options?: unknown) => {
      const call = calls.readArgs(path, options, true)
      return calls.promise('node:fs/promises', 'readFile', call.args, call.fields)
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
    unlink: (path: unknown) => {
      const resolved = fsTargetV1(path)
      return calls.promise('node:fs/promises', 'unlink', { path: resolved.value }, resolved.fields)
    },
    watch: (path: unknown, options?: unknown) =>
      createCapabilityFsWatchIteratorV1(bridge, { sync: calls.sync.bind(calls) }, path, options),
    writeFile: (path: unknown, value: unknown, options?: unknown) => {
      const call = calls.writeArgs(path, value, options, true)
      return calls.promise('node:fs/promises', 'writeFile', call.args, call.fields)
    }
  })
