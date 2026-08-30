import { utf8ByteLength } from '@holonomyjs/runtime/node-compat/utf8'
import { createChildProcessError, isChildProcessError } from './errors.js'
import { intrinsics } from './intrinsics.js'

import type { GitCallOptions } from '@holonomyjs/runtime/git/types'
import type { ChildProcessLimits } from './types.js'

const defaults: Readonly<ChildProcessLimits> = intrinsics.freeze({
  maxArgBytes: 64 * 1024,
  maxArgCount: 16,
  maxStderrBytes: 0,
  maxStdoutBytes: 256 * 1024
})

export const ownRecord = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || intrinsics.arrayIsArray(value)) {
    throw createChildProcessError('child_process.invalid_argument')
  }
  try {
    if (
      intrinsics.prototype(value) !== intrinsics.objectPrototype && intrinsics.prototype(value) !== null ||
      intrinsics.symbols(value).length !== 0
    ) throw new Error('invalid record')
    const output: Record<string, unknown> = intrinsics.create(null)
    for (const key of intrinsics.keys(value)) {
      if (intrinsics.arrayIndexOf(allowed, key) < 0) throw new Error('unknown key')
      const property = intrinsics.descriptor(value, key)
      if (!property || !intrinsics.hasOwn(property, 'value') || !property.enumerable) {
        throw new Error('invalid descriptor')
      }
      output[key] = property.value
    }
    return intrinsics.freeze(output)
  } catch {
    throw createChildProcessError('child_process.invalid_argument')
  }
}

export const snapshotArgs = (value: unknown, limits: Readonly<ChildProcessLimits>): readonly string[] => {
  if (!intrinsics.arrayIsArray(value)) throw createChildProcessError('child_process.invalid_argument')
  try {
    if (
      intrinsics.prototype(value) !== intrinsics.arrayPrototype || intrinsics.symbols(value).length !== 0 ||
      value.length > limits.maxArgCount
    ) throw new Error('invalid argv')
    const output: string[] = []
    let bytes = 0
    for (let index = 0; index < value.length; index += 1) {
      const property = intrinsics.descriptor(value, String(index))
      if (!property || !intrinsics.hasOwn(property, 'value') || typeof property.value !== 'string') {
        throw new Error('invalid argv item')
      }
      bytes += utf8ByteLength(property.value)
      if (bytes > limits.maxArgBytes) throw createChildProcessError('child_process.limit_exceeded')
      intrinsics.arrayPush(output, property.value)
    }
    return intrinsics.freeze(output)
  } catch (error) {
    throw isChildProcessError(error) ? error : createChildProcessError('child_process.invalid_argument')
  }
}

export const snapshotLimits = (value: unknown): Readonly<ChildProcessLimits> => {
  if (value === undefined) return defaults
  const record = ownRecord(value, ['maxArgBytes', 'maxArgCount', 'maxStderrBytes', 'maxStdoutBytes'])
  const output = { ...defaults }
  for (const key of intrinsics.keys(record) as Array<keyof ChildProcessLimits>) {
    const number = record[key]
    if (typeof number !== 'number' || !intrinsics.safeInteger(number) || number < 0) {
      throw createChildProcessError('child_process.invalid_argument')
    }
    output[key] = number
  }
  return intrinsics.freeze(output)
}

export interface CallOptions {
  readonly call: GitCallOptions
  readonly maxStdout: number
  readonly signal?: object
  readonly timeout?: number
}
export const optionsFor = (value: unknown, limits: Readonly<ChildProcessLimits>): CallOptions => {
  const options = ownRecord(value, ['encoding', 'maxBuffer', 'signal', 'timeout'])
  if (options.encoding !== undefined && options.encoding !== 'utf8' && options.encoding !== 'utf-8') {
    throw createChildProcessError('child_process.not_supported')
  }
  if (
    options.maxBuffer !== undefined &&
    (typeof options.maxBuffer !== 'number' || !intrinsics.safeInteger(options.maxBuffer) || options.maxBuffer < 0)
  ) throw createChildProcessError('child_process.invalid_argument')
  if (
    options.timeout !== undefined &&
    (typeof options.timeout !== 'number' || !intrinsics.safeInteger(options.timeout) || options.timeout <= 0)
  ) throw createChildProcessError('child_process.invalid_argument')
  if (options.signal !== undefined && (options.signal === null || typeof options.signal !== 'object')) {
    throw createChildProcessError('child_process.invalid_argument')
  }
  const timeout = options.timeout as number | undefined
  const signal = options.signal as object | undefined
  return intrinsics.freeze({
    call: intrinsics.freeze({
      ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
      ...(timeout === undefined ? {} : { timeoutMs: timeout })
    }),
    maxStdout: intrinsics.min(limits.maxStdoutBytes, options.maxBuffer as number | undefined ?? limits.maxStdoutBytes),
    signal,
    timeout
  })
}
