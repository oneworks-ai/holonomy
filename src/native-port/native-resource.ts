import type { NativeResourceHandle } from './types.js'

export interface NativeResourceHandleMetadata {
  controllerId: string
  isOpen: () => boolean
  principal: string
}

const RESOURCE_HANDLES = new WeakMap<object, NativeResourceHandleMetadata>()

export const createNativeResourceHandle = (
  type: string,
  metadata: NativeResourceHandleMetadata,
  close: (reason?: string) => boolean
): NativeResourceHandle => {
  const handle = Object.freeze(Object.defineProperties({}, {
    close: {
      enumerable: true,
      value: (reason?: string) => close(reason)
    },
    type: {
      enumerable: true,
      value: type
    }
  })) as NativeResourceHandle
  RESOURCE_HANDLES.set(handle, metadata)
  return handle
}

export const inspectNativeResourceHandle = (
  value: object
): NativeResourceHandleMetadata | undefined => RESOURCE_HANDLES.get(value)
