import { createFsError, isHolonomyFsError } from './errors.js'

import type { FsOperationName } from './types.js'

export const assertSupportedOptions = (
  options: object | undefined,
  allowedKeys: readonly string[],
  syscall: FsOperationName
) => {
  if (options === undefined) return Object.freeze({})
  try {
    if (
      options == null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.getPrototypeOf(options) !== Object.prototype
    ) throw createFsError('EINVAL', syscall)
    const snapshot: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(options)) {
      if (typeof key !== 'string' || !allowedKeys.includes(key)) {
        throw createFsError('EINVAL', syscall)
      }
      const descriptor = Object.getOwnPropertyDescriptor(options, key)
      if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
        throw createFsError('EINVAL', syscall)
      }
      snapshot[key] = descriptor.value
    }
    return Object.freeze(snapshot)
  } catch (error) {
    if (isHolonomyFsError(error)) throw error
    throw createFsError('EINVAL', syscall)
  }
}
