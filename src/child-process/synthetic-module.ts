/* eslint-disable max-lines -- terminal ownership remains auditable beside argv dispatch. */
import { utf8ByteLength } from '../node-compat/utf8.js'
import { createChildProcessError, isChildProcessError } from './errors.js'
import { intrinsics } from './intrinsics.js'
import { optionsFor, ownRecord, snapshotArgs, snapshotLimits } from './validation.js'

import type { GitRepository } from '../git/types.js'
import type {
  ChildProcessFactoryOptions,
  ChildProcessLimits,
  ChildProcessSyntheticModule,
  ChildProcessSyntheticModuleBinding,
  ExecFileCallback,
  ExecFileOptions
} from './types.js'

const query = '^remote\\..*\\.url$'

const codeOf = (value: unknown): string | undefined => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined
  try {
    const property = intrinsics.descriptor(value, 'code')
    return property && intrinsics.hasOwn(property, 'value') && typeof property.value === 'string'
      ? property.value
      : undefined
  } catch {
    return undefined
  }
}
const mapError = (value: unknown): Error => {
  if (isChildProcessError(value)) return value
  const code = codeOf(value)
  if (code !== 'git.cancelled' && code !== 'git.timeout' && code !== 'git.limit_exceeded') {
    return createChildProcessError('child_process.internal')
  }
  return createChildProcessError(
    code === 'git.cancelled'
      ? 'child_process.cancelled'
      : code === 'git.timeout'
      ? 'child_process.timeout'
      : 'child_process.limit_exceeded'
  )
}
const controlFree = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    if (intrinsics.charCodeAt(value, index) <= 31 || intrinsics.charCodeAt(value, index) === 127) return false
  }
  return true
}
const render = (value: unknown, maximum: number): string => {
  if (!intrinsics.arrayIsArray(value)) throw createChildProcessError('child_process.internal')
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const item = intrinsics.descriptor(value, String(index))
    if (!item || !intrinsics.hasOwn(item, 'value')) throw createChildProcessError('child_process.internal')
    const remote = ownRecord(item.value, ['authorized', 'fetchUrl', 'name', 'pushUrl'])
    if (typeof remote.authorized !== 'boolean' || typeof remote.name !== 'string' || !controlFree(remote.name)) {
      throw createChildProcessError('child_process.internal')
    }
    if (remote.fetchUrl !== undefined && (typeof remote.fetchUrl !== 'string' || !controlFree(remote.fetchUrl))) {
      throw createChildProcessError('child_process.internal')
    }
    if (!remote.authorized || remote.fetchUrl === undefined) continue
    const line = `remote.${remote.name}.url ${remote.fetchUrl}\n`
    if (utf8ByteLength(output) + utf8ByteLength(line) > maximum) {
      throw createChildProcessError('child_process.limit_exceeded')
    }
    output += line
  }
  return output
}
const method = (
  owner: object,
  name: string,
  code: 'child_process.invalid_argument' | 'child_process.internal'
): Function => {
  try {
    let target: object | null = owner
    let property: PropertyDescriptor | undefined
    for (let depth = 0; depth < 2 && target !== null; depth += 1) {
      property = intrinsics.descriptor(target, name)
      if (property) break
      target = intrinsics.prototype(target)
    }
    if (target === intrinsics.objectPrototype) property = undefined
    if (
      !property || !intrinsics.hasOwn(property, 'value') || typeof property.value !== 'function' ||
      intrinsics.descriptor(property.value, 'then')
    ) throw createChildProcessError(code)
    return property.value
  } catch {
    throw createChildProcessError(code)
  }
}
const promise = (value: unknown, yes: (value: unknown) => void, no: (error: unknown) => void): void => {
  try {
    intrinsics.promiseThen(value as Promise<unknown>, yes, no)
  } catch {
    no(createChildProcessError('child_process.internal'))
  }
}

interface Terminal {
  active(): boolean
  close(error: Error | null, stdout?: string): void
  own(close: () => void): void
}
const terminal = (callback: ExecFileCallback, signal: object | undefined, timeout: number | undefined): Terminal => {
  let live = true
  let timer: unknown
  let listener: (() => void) | undefined
  let remove: Function | undefined
  const closers: Array<() => void> = []
  const dispatch = (error: Error | null, stdout = '') => {
    try {
      intrinsics.promiseThen(intrinsics.resolve(), () => {
        try {
          intrinsics.apply(callback, undefined, [error, stdout, ''])
        } catch {}
      }, () => {})
    } catch {}
  }
  const finish = (error: Error | null, stdout = '') => {
    if (!live) return
    live = false
    if (timer !== undefined) {
      try {
        intrinsics.clearTimeout?.(timer)
      } catch {}
    }
    if (listener && remove) {
      try {
        intrinsics.apply(remove, signal, ['abort', listener])
      } catch {}
    }
    for (let index = 0; index < closers.length; index += 1) {
      try {
        closers[index]!()
      } catch {}
    }
    dispatch(error, stdout)
  }
  if (timeout !== undefined) {
    if (!intrinsics.setTimeout) finish(createChildProcessError('child_process.not_supported'))
    else timer = intrinsics.setTimeout(() => finish(createChildProcessError('child_process.timeout')), timeout)
  }
  if (signal) {
    try {
      const platform = intrinsics.abort
      const isPlatform = platform !== undefined && (() => {
        try {
          return typeof intrinsics.apply(platform.aborted, signal, []) === 'boolean'
        } catch {
          return false
        }
      })()
      if (!isPlatform) throw new Error('invalid abort signal')
      remove = platform!.removeEventListener
      listener = () => finish(createChildProcessError('child_process.cancelled'))
      const aborted = intrinsics.apply(platform!.aborted, signal, []) as boolean
      if (aborted) finish(createChildProcessError('child_process.cancelled'))
      else {intrinsics.apply(platform!.addEventListener, signal, ['abort', listener, {
          once: true
        }])}
    } catch {
      finish(createChildProcessError('child_process.internal'))
    }
  }
  return intrinsics.freeze({
    active: () => live,
    close: finish,
    own: (close: () => void) => {
      if (live) intrinsics.arrayPush(closers, close)
      else close()
    }
  })
}

export const createChildProcessSyntheticModule = (factory: ChildProcessFactoryOptions): ChildProcessSyntheticModule => {
  const input = ownRecord(factory, ['git', 'limits'])
  if (input.git === null || typeof input.git !== 'object') {
    throw createChildProcessError('child_process.invalid_argument')
  }
  const facade = input.git as object
  const open = method(facade, 'open', 'child_process.invalid_argument')
  const clone = method(facade, 'clone', 'child_process.invalid_argument')
  const limits = snapshotLimits(input.limits as Partial<ChildProcessLimits> | undefined)
  const execFile = (
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: ExecFileCallback
  ): void => {
    let done: Terminal | undefined
    try {
      done = terminal(callback, undefined, undefined)
      if (file !== 'git' || typeof callback !== 'function') throw createChildProcessError('child_process.not_supported')
      const argv = snapshotArgs(args, limits)
      const call = optionsFor(options, limits)
      done = terminal(callback, call.signal, call.timeout)
      if (!done.active()) return
      const remote = argv.length === 5 && argv[0] === '-C' && argv[2] === 'config' && argv[3] === '--get-regexp' &&
        argv[4] === query
      const branch = argv[3] === '--branch' ? argv[4] : undefined
      const start = branch === undefined ? 3 : 5
      const cloning = argv[0] === 'clone' && argv[1] === '--depth' && argv[2] === '1' && argv.length === start + 2
      if (!remote && !cloning) throw createChildProcessError('child_process.not_supported')
      const result = remote
        ? intrinsics.apply(open, facade, [argv[1], call.call])
        : intrinsics.apply(clone, facade, [{
          ...(branch === undefined ? {} : { branch }),
          depth: 1,
          destination: argv[start + 1],
          url: argv[start]
        }, call.call])
      promise(result, repositoryValue => {
        const repository = repositoryValue as GitRepository
        let close: Function
        try {
          if (!done) return
          const activeTerminal = done
          close = method(repository as object, 'close', 'child_process.internal')
          activeTerminal.own(() => {
            intrinsics.apply(close, repository, ['child_process_complete'])
          })
          if (!activeTerminal.active()) return
          if (!remote) {
            activeTerminal.close(null)
            return
          }
          const list = method(repository as object, 'listRemotes', 'child_process.internal')
          promise(
            intrinsics.apply(list, repository, [call.call]),
            remotes => {
              try {
                activeTerminal.close(null, render(remotes, call.maxStdout))
              } catch (error) {
                activeTerminal.close(mapError(error))
              }
            },
            error => activeTerminal.close(mapError(error))
          )
        } catch (error) {
          done?.close(mapError(error))
        }
      }, error => done?.close(mapError(error)))
    } catch (error) {
      done?.close(mapError(error))
    }
  }
  const namespace = intrinsics.freeze({ execFile })
  return intrinsics.freeze({ ...namespace, default: namespace })
}
export const createChildProcessSyntheticModuleBinding = (
  factory: ChildProcessFactoryOptions
): ChildProcessSyntheticModuleBinding => {
  const namespace = createChildProcessSyntheticModule(factory)
  return intrinsics.freeze({
    descriptor: intrinsics.freeze({ exportNames: intrinsics.freeze(intrinsics.keys(namespace)) }),
    namespace
  })
}
