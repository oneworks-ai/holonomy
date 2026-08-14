import type { CapabilityGuestBridgeV1 } from './guest-facade-support.js'
import { createCapabilityRequestV1, readCapabilityTerminalV1 } from './guest-facade-support.js'
import {
  fsDataV1,
  fsFunctionV1,
  fsJsonObjectV1,
  fsReadOptionsV1,
  fsTargetV1,
  fsWriteOptionsV1
} from './guest-fs-support.js'
import type { FsCapabilityFieldsV1 } from './guest-fs-support.js'
import type { JsonValueV1 } from './json-types.js'

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
    fields: FsCapabilityFieldsV1
  ): Promise<unknown> {
    return readCapabilityTerminalV1(
      await this.#bridge.invoke(createCapabilityRequestV1(module, member, 'promise', args, fields))
    )
  }

  callback(
    module: string,
    member: string,
    args: JsonValueV1,
    fields: FsCapabilityFieldsV1,
    done: unknown,
    result: boolean
  ): void {
    const accepted = fsFunctionV1(done)
    void this.#bridge.invoke(createCapabilityRequestV1(module, member, 'callback', args, fields)).then(
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
    return {
      args: { options: fsReadOptionsV1(options, async), path: resolved.value },
      fields: resolved.fields
    }
  }

  writeArgs(path: unknown, value: unknown, options: unknown, async: boolean) {
    const resolved = fsTargetV1(path)
    return {
      args: {
        data: fsDataV1(value),
        options: fsWriteOptionsV1(options, async),
        path: resolved.value
      },
      fields: resolved.fields
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
