import { createFsError } from './errors.js'

import type { NativeJsonValue } from '@holonomyjs/runtime/native-port/types'
import type { FsOperationName } from './types.js'

export const readResultRecord = (
  value: NativeJsonValue | undefined,
  keys: readonly string[],
  syscall: FsOperationName
) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw createFsError('EIO', syscall)
  }
  const actualKeys = Reflect.ownKeys(value)
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some(key => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw createFsError('EIO', syscall)
  }
  return value
}

export const readResultString = (
  record: object,
  key: string,
  syscall: FsOperationName
) => {
  const value = Object.getOwnPropertyDescriptor(record, key)?.value
  if (typeof value !== 'string') throw createFsError('EIO', syscall)
  return value
}

export const readResultInteger = (
  record: object,
  key: string,
  syscall: FsOperationName
) => {
  const value = Object.getOwnPropertyDescriptor(record, key)?.value
  if (!Number.isSafeInteger(value) || value < 0) {
    throw createFsError('EIO', syscall)
  }
  return value as number
}

export const readResultValue = (
  record: object,
  key: string
) => Object.getOwnPropertyDescriptor(record, key)?.value as NativeJsonValue | undefined
