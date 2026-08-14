import type { CapabilityGuestBridgeV1 } from './guest-facade-support.js'
import { capabilityTextPathV1 } from './guest-facade-support.js'
import type { CapabilityFsFacadeCallsV1 } from './guest-fs-calls.js'
import { createCapabilityFsWatcherV1 } from './guest-fs-resources.js'
import {
  fsDirentsV1,
  fsFunctionV1,
  fsJsonObjectV1,
  fsMkdirResultV1,
  fsObjectV1,
  fsStatsV1,
  fsTargetV1,
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
    calls.callback('node:fs', 'readFile', call.args, call.fields, done ?? options, true)
  }
  const writeFileSync = (path: unknown, value: unknown, options?: unknown) => {
    const call = calls.writeArgs(path, value, options, false)
    calls.sync('node:fs', 'writeFileSync', call.args, call.fields)
  }
  const writeFile = (path: unknown, value: unknown, options: unknown, done?: unknown) => {
    const call = calls.writeArgs(path, value, done === undefined ? undefined : options, true)
    calls.callback('node:fs', 'writeFile', call.args, call.fields, done ?? options, false)
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
  return Object.freeze({
    close,
    closeSync,
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
    writeFile,
    writeFileSync
  })
}
