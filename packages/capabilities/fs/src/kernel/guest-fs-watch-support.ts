import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import { fsObjectV1, invalidFsValueV1 } from './guest-fs-support.js'

export const fsWatchQueueLimitV1 = (value: unknown): number => {
  const source = fsObjectV1(value)
  const maximum = source.maxQueuedEvents
  if (!Number.isSafeInteger(maximum) || (maximum as number) < 1 || (maximum as number) > 4096) {
    return invalidFsValueV1('Invalid filesystem watch queue limit')
  }
  return maximum as number
}

export const fsWatchErrorV1 = (code: 'ABORT_ERR' | 'ENOSPC', message: string, name = 'Error') =>
  Object.assign(new Error(message), { code, name })

export const fsWatchProviderErrorV1 = (value: unknown): Error => {
  if (value instanceof Error) return value
  const snapshot = fsObjectV1(value)
  return Object.assign(new Error(typeof snapshot.message === 'string' ? snapshot.message : 'Filesystem watch failed'), {
    code: snapshot.code,
    name: typeof snapshot.name === 'string' ? snapshot.name : 'Error',
    ...(typeof snapshot.retryable === 'boolean' ? { retryable: snapshot.retryable } : {})
  })
}

export const fsWatchOptionsSnapshotV1 = (source: Record<string, unknown>) => {
  const output: Record<string, JsonValueV1> = {}
  for (const key of ['encoding', 'maxQueuedEvents', 'persistent', 'recursive']) {
    if (source[key] !== undefined) output[key] = source[key] as JsonValueV1
  }
  return output
}
