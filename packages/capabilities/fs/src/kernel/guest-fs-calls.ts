import type {
  CapabilityGuestAbortSignalV1,
  CapabilityGuestBridgeV1
} from '@holonomyjs/runtime/kernel/guest-facade-support'
import { createCapabilityRequestV1, readCapabilityTerminalV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import {
  fsDataV1,
  fsFunctionV1,
  fsJsonObjectV1,
  fsReadOptionsV1,
  fsTargetV1,
  fsWriteOptionsV1
} from './guest-fs-support.js'
import type { FsCapabilityFieldsV1 } from './guest-fs-support.js'

export class CapabilityFsFacadeCallsV1 {
  #bridge

  constructor(bridge: CapabilityGuestBridgeV1) {
    this.#bridge = bridge
  }

  sync(module: string, member: string, args: JsonValueV1, fields: FsCapabilityFieldsV1): unknown {
    return readCapabilityTerminalV1(
      this.#bridge.invokeSync(createCapabilityRequestV1(module, member, 'sync', args, fields))
    )
  }

  async promise(
    module: string,
    member: string,
    args: JsonValueV1,
    fields: FsCapabilityFieldsV1,
    signal?: CapabilityGuestAbortSignalV1
  ): Promise<unknown> {
    return readCapabilityTerminalV1(
      await this.#bridge.invoke(createCapabilityRequestV1(module, member, 'promise', args, fields), signal)
    )
  }

  callback(
    module: string,
    member: string,
    args: JsonValueV1,
    fields: FsCapabilityFieldsV1,
    done: unknown,
    result: boolean,
    signal?: CapabilityGuestAbortSignalV1
  ): void {
    const accepted = fsFunctionV1(done)
    void this.#bridge.invoke(createCapabilityRequestV1(module, member, 'callback', args, fields), signal).then(
      terminal => {
        let value: unknown
        try {
          value = readCapabilityTerminalV1(terminal)
        } catch (error) {
          accepted(error)
          return
        }
        if (result) accepted(null, value)
        else accepted(null)
      },
      error => accepted(error)
    )
  }

  readArgs(path: unknown, options: unknown, async: boolean) {
    const resolved = fsTargetV1(path)
    const prepared = fsReadOptionsV1(options, async)
    return {
      args: { options: prepared.options, path: resolved.value },
      fields: resolved.fields,
      signal: prepared.signal
    }
  }

  writeArgs(path: unknown, value: unknown, options: unknown, async: boolean) {
    const resolved = fsTargetV1(path)
    const prepared = fsWriteOptionsV1(options, async)
    return {
      args: {
        data: fsDataV1(value),
        options: prepared.options,
        path: resolved.value
      },
      fields: resolved.fields,
      signal: prepared.signal
    }
  }

  pathCall(
    module: string,
    member: string,
    path: unknown,
    options: unknown,
    mode: 'promise' | 'sync'
  ): Promise<unknown> | unknown {
    const resolved = fsTargetV1(path)
    const args = { options: options == null ? {} : fsJsonObjectV1(options), path: resolved.value }
    return mode === 'sync'
      ? this.sync(module, member, args, resolved.fields)
      : this.promise(module, member, args, resolved.fields)
  }
}
