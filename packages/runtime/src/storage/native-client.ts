import type {
  NativeArgumentValue,
  NativeBinary,
  NativeBridge,
  NativeCallOptions,
  NativeResult
} from '../native-port/types.js'
import { STORAGE_NATIVE_MODULE } from './constants.js'
import { createStorageError, mapStorageBridgeError } from './errors.js'
import type { StorageCallOptions } from './types.js'

let nextClientId = 1

export class StorageNativeClient {
  readonly #clientId = nextClientId++
  #nextRequestId = 1
  constructor(private readonly bridge: NativeBridge) {}

  async request(
    operation: string,
    args: NativeArgumentValue,
    options: StorageCallOptions = {},
    binary?: readonly NativeBinary[]
  ): Promise<NativeResult> {
    try {
      const snapshot = this.options(options)
      return await this.bridge.request({
        args,
        ...(binary == null ? {} : { binary }),
        ...(Object.hasOwn(snapshot, 'deadlineMs') ? { deadlineMs: snapshot.deadlineMs as number } : {}),
        id: `storage:${this.#clientId}:${this.#nextRequestId++}`,
        module: STORAGE_NATIVE_MODULE,
        operation
      }, this.callOptions(snapshot))
    } catch (error) {
      throw mapStorageBridgeError(error, operation)
    }
  }

  private callOptions(options: Readonly<StorageCallOptions>): NativeCallOptions {
    return {
      ...(Object.hasOwn(options, 'signal') ? { signal: options.signal as AbortSignal } : {}),
      ...(Object.hasOwn(options, 'timeoutMs') ? { timeoutMs: options.timeoutMs as number } : {})
    }
  }
  private options(options: StorageCallOptions): Readonly<StorageCallOptions> {
    try {
      if (options == null || Object.getPrototypeOf(options) !== Object.prototype) throw new Error('invalid options')
      const out: Record<string, unknown> = {}
      for (const key of ['deadlineMs', 'signal', 'timeoutMs']) {
        const descriptor = Object.getOwnPropertyDescriptor(options, key)
        if (descriptor == null) continue
        if (!descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
          throw new Error('invalid option')
        }
        out[key] = descriptor.value
      }
      if (
        Object.hasOwn(out, 'deadlineMs') && (!Number.isSafeInteger(out.deadlineMs) || (out.deadlineMs as number) < 0)
      ) throw new Error('invalid deadline')
      if (Object.hasOwn(out, 'timeoutMs') && (!Number.isSafeInteger(out.timeoutMs) || (out.timeoutMs as number) <= 0)) {
        throw new Error('invalid timeout')
      }
      if (Object.hasOwn(out, 'signal') && (out.signal == null || typeof out.signal !== 'object')) {
        throw new Error('invalid signal')
      }
      return Object.freeze(out) as Readonly<StorageCallOptions>
    } catch {
      throw createStorageError('storage.invalid_argument')
    }
  }
}
