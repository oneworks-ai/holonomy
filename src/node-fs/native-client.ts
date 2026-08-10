import { FS_NATIVE_MODULE } from './constants.js'
import { mapNativeBridgeError } from './errors.js'

import type { NativeArgumentValue, NativeBinary, NativeBridge, NativeStream } from '../native-port/types.js'
import type { FsCallOptions, FsOperationName } from './types.js'

export interface FsDispatchOptions extends FsCallOptions {
  /** Internal absolute deadline; it is never accepted from a guest object. */
  deadlineMs?: number
}

let nextClientId = 1

export class FsNativeClient {
  readonly #clientId = nextClientId++
  #nextRequestId = 1

  constructor(private readonly bridge: NativeBridge) {}

  async request(
    operation: string,
    args: NativeArgumentValue,
    syscall: FsOperationName,
    options: FsDispatchOptions = {},
    binary?: readonly NativeBinary[]
  ) {
    try {
      return await this.bridge.request({
        args,
        ...(binary == null ? {} : { binary }),
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
        id: this.requestId(),
        module: FS_NATIVE_MODULE,
        operation
      }, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.deadlineMs === undefined && options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {})
      })
    } catch (error) {
      throw mapNativeBridgeError(error, syscall)
    }
  }

  stream(
    operation: string,
    args: NativeArgumentValue,
    syscall: FsOperationName,
    options: FsDispatchOptions = {}
  ): NativeStream {
    try {
      return this.bridge.stream({
        args,
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
        id: this.requestId(),
        module: FS_NATIVE_MODULE,
        operation
      }, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.deadlineMs === undefined && options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {})
      })
    } catch (error) {
      throw mapNativeBridgeError(error, syscall)
    }
  }

  private requestId() {
    const id = `fs:${this.#clientId}:${this.#nextRequestId}`
    this.#nextRequestId += 1
    return id
  }
}
