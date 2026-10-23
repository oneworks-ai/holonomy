/* eslint-disable max-lines -- One standard node:fs binding keeps overload signatures together. */
import type { CapabilityGuestBridgeV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import { capabilityTextPathV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import type { CapabilityFsFacadeCallsV1 } from './guest-fs-calls.js'
import { createCapabilityFsWatcherV1 } from './guest-fs-resources.js'
import {
  fsAccessModeV1,
  fsChmodModeV1,
  fsDescriptorTargetV1,
  fsDirentsV1,
  fsFunctionV1,
  fsJsonObjectV1,
  fsLengthV1,
  fsMkdirResultV1,
  fsObjectV1,
  fsStatsV1,
  fsTargetV1,
  fsTimesV1,
  invalidFsValueV1
} from './guest-fs-support.js'

export const createCapabilityFsNodeModuleV1 = (
  bridge: CapabilityGuestBridgeV1,
  calls: CapabilityFsFacadeCallsV1
) => {
  const readFileSync = (path: unknown, options?: unknown) => {
    const call = calls.readArgs(path, options, false)
    return calls.sync('node:fs', 'readFileSync', call.args, call.fields)
  }
  const readFile = (path: unknown, options: unknown, done?: unknown) => {
    const call = calls.readArgs(path, done === undefined ? undefined : options, true)
    calls.callback('node:fs', 'readFile', call.args, call.fields, done ?? options, true, call.signal)
  }
  const writeFileSync = (path: unknown, value: unknown, options?: unknown) => {
    const call = calls.writeArgs(path, value, options, false)
    calls.sync('node:fs', 'writeFileSync', call.args, call.fields)
  }
  const writeFile = (path: unknown, value: unknown, options: unknown, done?: unknown) => {
    const call = calls.writeArgs(path, value, done === undefined ? undefined : options, true)
    calls.callback('node:fs', 'writeFile', call.args, call.fields, done ?? options, false, call.signal)
  }
  const openSync = (path: unknown, flag: unknown) => {
    const resolved = fsTargetV1(path)
    if (typeof flag !== 'string') return invalidFsValueV1('Invalid file flag')
    return fsObjectV1(calls.sync(
      'node:fs',
      'openSync',
      { flag, path: resolved.value },
      resolved.fields
    )).fd
  }
  const open = (path: unknown, flag: unknown, done: unknown) => {
    const resolved = fsTargetV1(path)
    if (typeof flag !== 'string') return invalidFsValueV1('Invalid file flag')
    calls.callback(
      'node:fs',
      'open',
      { flag, path: resolved.value },
      resolved.fields,
      (error: unknown, value: unknown) => {
        fsFunctionV1(done)(error, error == null ? fsObjectV1(value).fd : undefined)
      },
      true
    )
  }
  const closeSync = (fd: unknown) => {
    const resolved = fsTargetV1(fd)
    calls.sync('node:fs', 'closeSync', { fd: fsObjectV1(resolved.value).fd as number }, resolved.fields)
  }
  const close = (fd: unknown, done: unknown) => {
    const resolved = fsTargetV1(fd)
    calls.callback(
      'node:fs',
      'close',
      { fd: fsObjectV1(resolved.value).fd as number },
      resolved.fields,
      done,
      false
    )
  }
  const fileSync = (fd: unknown, member: string, sync: boolean, done?: unknown) => {
    const resolved = fsDescriptorTargetV1(fd)
    if (sync) {
      calls.sync('node:fs', `${member}Sync`, { fd: resolved.fd }, resolved.fields)
      return
    }
    calls.callback('node:fs', member, { fd: resolved.fd }, resolved.fields, done, false)
  }
  const handleTimes = (fd: unknown, atime: unknown, mtime: unknown, sync: boolean, done?: unknown) => {
    const resolved = fsDescriptorTargetV1(fd)
    const args = { ...fsTimesV1(atime, mtime), fd: resolved.fd }
    if (sync) {
      calls.sync('node:fs', 'futimesSync', args, resolved.fields)
      return
    }
    calls.callback('node:fs', 'futimes', args, resolved.fields, done, false)
  }
  const handleTruncate = (fd: unknown, len: unknown, sync: boolean, done?: unknown) => {
    const resolved = fsDescriptorTargetV1(fd)
    const args = { fd: resolved.fd, len: fsLengthV1(len) }
    if (sync) {
      calls.sync('node:fs', 'ftruncateSync', args, resolved.fields)
      return
    }
    calls.callback('node:fs', 'ftruncate', args, resolved.fields, done, false)
  }
  const pathTimes = (path: unknown, atime: unknown, mtime: unknown, sync: boolean, done?: unknown) => {
    const value = capabilityTextPathV1(path)
    const args = { path: value, ...fsTimesV1(atime, mtime) }
    if (sync) {
      calls.sync('node:fs', 'utimesSync', args, { path: value })
      return
    }
    calls.callback('node:fs', 'utimes', args, { path: value }, done, false)
  }
  const pathTruncate = (path: unknown, len: unknown, sync: boolean, done?: unknown) => {
    const value = capabilityTextPathV1(path)
    const args = { path: value, len: fsLengthV1(len) }
    if (sync) {
      calls.sync('node:fs', 'truncateSync', args, { path: value })
      return
    }
    calls.callback('node:fs', 'truncate', args, { path: value }, done, false)
  }
  const pathAccess = (path: unknown, mode: unknown, sync: boolean, done?: unknown) => {
    const value = capabilityTextPathV1(path)
    const args = { path: value, mode: fsAccessModeV1(mode) }
    if (sync) {
      calls.sync('node:fs', 'accessSync', args, { path: value })
      return
    }
    calls.callback('node:fs', 'access', args, { path: value }, done ?? mode, false)
  }
  const pathChmod = (path: unknown, mode: unknown, sync: boolean, done?: unknown) => {
    const value = capabilityTextPathV1(path)
    const args = { path: value, mode: fsChmodModeV1(mode) }
    if (sync) {
      calls.sync('node:fs', 'chmodSync', args, { path: value })
      return
    }
    calls.callback('node:fs', 'chmod', args, { path: value }, done, false)
  }
  const handleChmod = (fd: unknown, mode: unknown, sync: boolean, done?: unknown) => {
    const resolved = fsDescriptorTargetV1(fd)
    const args = { fd: resolved.fd, mode: fsChmodModeV1(mode) }
    if (sync) {
      calls.sync('node:fs', 'fchmodSync', args, resolved.fields)
      return
    }
    calls.callback('node:fs', 'fchmod', args, resolved.fields, done, false)
  }
  return Object.freeze({
    access: (path: unknown, mode: unknown, done?: unknown) =>
      pathAccess(path, typeof mode === 'function' ? undefined : mode, false, done ?? mode),
    accessSync: (path: unknown, mode?: unknown) => pathAccess(path, mode, true),
    chmod: (path: unknown, mode: unknown, done: unknown) => pathChmod(path, mode, false, done),
    chmodSync: (path: unknown, mode: unknown) => pathChmod(path, mode, true),
    close,
    closeSync,
    constants: Object.freeze({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 }),
    fdatasync: (fd: unknown, done: unknown) => fileSync(fd, 'fdatasync', false, done),
    fdatasyncSync: (fd: unknown) => fileSync(fd, 'fdatasync', true),
    fchmod: (fd: unknown, mode: unknown, done: unknown) => handleChmod(fd, mode, false, done),
    fchmodSync: (fd: unknown, mode: unknown) => handleChmod(fd, mode, true),
    fsync: (fd: unknown, done: unknown) => fileSync(fd, 'fsync', false, done),
    fsyncSync: (fd: unknown) => fileSync(fd, 'fsync', true),
    ftruncate: (fd: unknown, len: unknown, done?: unknown) =>
      handleTruncate(fd, typeof len === 'function' ? undefined : len, false, done ?? len),
    ftruncateSync: (fd: unknown, len?: unknown) => handleTruncate(fd, len, true),
    futimes: (fd: unknown, atime: unknown, mtime: unknown, done: unknown) => handleTimes(fd, atime, mtime, false, done),
    futimesSync: (fd: unknown, atime: unknown, mtime: unknown) => handleTimes(fd, atime, mtime, true),
    lstat: (path: unknown, options: unknown, done?: unknown) => {
      const resolved = fsTargetV1(path)
      calls.callback(
        'node:fs',
        'lstat',
        { options: done === undefined ? {} : fsJsonObjectV1(options), path: resolved.value },
        resolved.fields,
        (error: unknown, value: unknown) => {
          fsFunctionV1(done ?? options)(error, error == null ? fsStatsV1(value) : undefined)
        },
        true
      )
    },
    lstatSync: (path: unknown, options?: unknown) =>
      fsStatsV1(calls.pathCall('node:fs', 'lstatSync', path, options, 'sync')),
    mkdir: (path: unknown, options: unknown, done?: unknown) => {
      const resolved = fsTargetV1(path)
      const args = { options: done === undefined ? {} : fsJsonObjectV1(options), path: resolved.value }
      calls.callback(
        'node:fs',
        'mkdir',
        args,
        resolved.fields,
        (error: unknown, value: unknown) => {
          fsFunctionV1(done ?? options)(
            error,
            error == null && args.options.recursive === true ? fsMkdirResultV1(value) : undefined
          )
        },
        true
      )
    },
    mkdirSync: (path: unknown, options?: unknown) =>
      fsMkdirResultV1(calls.pathCall('node:fs', 'mkdirSync', path, options, 'sync')),
    open,
    openSync,
    readFile,
    readFileSync,
    readdir: (path: unknown, options: unknown, done?: unknown) => {
      const resolved = fsTargetV1(path)
      calls.callback(
        'node:fs',
        'readdir',
        { options: done === undefined ? {} : fsJsonObjectV1(options), path: resolved.value },
        resolved.fields,
        (error: unknown, value: unknown) => {
          fsFunctionV1(done ?? options)(error, error == null ? fsDirentsV1(value) : undefined)
        },
        true
      )
    },
    readdirSync: (path: unknown, options?: unknown) =>
      fsDirentsV1(calls.pathCall('node:fs', 'readdirSync', path, options, 'sync')),
    rename: (from: unknown, to: unknown, done: unknown) => {
      const resolved = fsTargetV1(from)
      calls.callback(
        'node:fs',
        'rename',
        { from: resolved.value, to: capabilityTextPathV1(to) },
        resolved.fields,
        done,
        false
      )
    },
    renameSync: (from: unknown, to: unknown) => {
      const resolved = fsTargetV1(from)
      calls.sync(
        'node:fs',
        'renameSync',
        { from: resolved.value, to: capabilityTextPathV1(to) },
        resolved.fields
      )
    },
    stat: (path: unknown, options: unknown, done?: unknown) => {
      const resolved = fsTargetV1(path)
      calls.callback(
        'node:fs',
        'stat',
        { options: done === undefined ? {} : fsJsonObjectV1(options), path: resolved.value },
        resolved.fields,
        (error: unknown, value: unknown) => {
          fsFunctionV1(done ?? options)(error, error == null ? fsStatsV1(value) : undefined)
        },
        true
      )
    },
    statSync: (path: unknown, options?: unknown) =>
      fsStatsV1(calls.pathCall('node:fs', 'statSync', path, options, 'sync')),
    truncate: (path: unknown, len: unknown, done?: unknown) =>
      pathTruncate(path, typeof len === 'function' ? undefined : len, false, done ?? len),
    truncateSync: (path: unknown, len?: unknown) => pathTruncate(path, len, true),
    unlink: (path: unknown, done: unknown) => {
      const resolved = fsTargetV1(path)
      calls.callback('node:fs', 'unlink', { path: resolved.value }, resolved.fields, done, false)
    },
    unlinkSync: (path: unknown) => {
      const resolved = fsTargetV1(path)
      calls.sync('node:fs', 'unlinkSync', { path: resolved.value }, resolved.fields)
    },
    watch: (path: unknown, options: unknown, listener?: unknown) =>
      createCapabilityFsWatcherV1(bridge, { sync: calls.sync.bind(calls) }, path, options, listener),
    utimes: (path: unknown, atime: unknown, mtime: unknown, done: unknown) =>
      pathTimes(path, atime, mtime, false, done),
    utimesSync: (path: unknown, atime: unknown, mtime: unknown) => pathTimes(path, atime, mtime, true),
    writeFile,
    writeFileSync
  })
}
