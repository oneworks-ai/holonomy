import { encodeUtf8 } from '../web-network/utf8.js'

import type { NativeJsonValue } from '../native-port/types.js'
import type { NetworkMockRuleStore } from '../web-network/network-rules.js'
import type { NetworkMockRuleSet } from '../web-network/types.js'

export interface RuntimeControlCommand {
  readonly generation: number
  readonly id: string
  readonly operation: string
  readonly value?: NativeJsonValue
}

export interface RuntimeControlResult {
  readonly generation: number
  readonly value?: NativeJsonValue
}

export type RuntimeControlHandler = (
  value: NativeJsonValue | undefined
) => NativeJsonValue | undefined | Promise<NativeJsonValue | undefined>

export interface RuntimeControlChannelOptions {
  readonly generation: number
  readonly handlers: Readonly<Record<string, RuntimeControlHandler>>
  readonly maxCommandBytes?: number
  readonly maxRememberedCommands?: number
}

export class RuntimeControlError extends Error {
  readonly code:
    | 'runtime_control.disposed'
    | 'runtime_control.generation_conflict'
    | 'runtime_control.invalid_command'
    | 'runtime_control.operation_unsupported'

  constructor(code: RuntimeControlError['code']) {
    super(code)
    this.name = 'RuntimeControlError'
    this.code = code
  }
}

interface RememberedCommand {
  fingerprint: string
  result: Promise<RuntimeControlResult>
}

const validPositive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0

/** Trusted host control plane. It is deliberately absent from runtime globals. */
export class RuntimeControlChannel {
  private readonly generation: number
  private readonly handlers = new Map<string, RuntimeControlHandler>()
  private readonly maxCommandBytes: number
  private readonly maxRememberedCommands: number
  private readonly remembered = new Map<string, RememberedCommand>()
  private disposed = false
  private tail = Promise.resolve()

  constructor(options: RuntimeControlChannelOptions) {
    if (!Number.isSafeInteger(options.generation) || options.generation < 0) {
      throw new RuntimeControlError('runtime_control.invalid_command')
    }
    this.generation = options.generation
    this.maxCommandBytes = options.maxCommandBytes ?? 1024 * 1024
    this.maxRememberedCommands = options.maxRememberedCommands ?? 1024
    if (!validPositive(this.maxCommandBytes) || !validPositive(this.maxRememberedCommands)) {
      throw new RuntimeControlError('runtime_control.invalid_command')
    }
    for (const [operation, handler] of Object.entries(options.handlers)) {
      if (operation === '' || typeof handler !== 'function') {
        throw new RuntimeControlError('runtime_control.invalid_command')
      }
      this.handlers.set(operation, handler)
    }
  }

  apply(command: RuntimeControlCommand): Promise<RuntimeControlResult> {
    if (this.disposed) return Promise.reject(new RuntimeControlError('runtime_control.disposed'))
    let fingerprint: string
    try {
      fingerprint = JSON.stringify(command)
      if (
        command == null || typeof command !== 'object' || typeof command.id !== 'string' || command.id === '' ||
        typeof command.operation !== 'string' || command.operation === '' ||
        encodeUtf8(fingerprint).byteLength > this.maxCommandBytes
      ) throw new RuntimeControlError('runtime_control.invalid_command')
    } catch (error) {
      return Promise.reject(
        error instanceof RuntimeControlError
          ? error
          : new RuntimeControlError('runtime_control.invalid_command')
      )
    }
    if (command.generation !== this.generation) {
      return Promise.reject(new RuntimeControlError('runtime_control.generation_conflict'))
    }
    const previous = this.remembered.get(command.id)
    if (previous != null) {
      return previous.fingerprint === fingerprint
        ? previous.result
        : Promise.reject(new RuntimeControlError('runtime_control.invalid_command'))
    }
    const handler = this.handlers.get(command.operation)
    if (handler == null) return Promise.reject(new RuntimeControlError('runtime_control.operation_unsupported'))
    const result = this.tail.then(async () => {
      if (this.disposed) throw new RuntimeControlError('runtime_control.disposed')
      const value = await handler(command.value)
      return Object.freeze({ generation: this.generation, ...(value === undefined ? {} : { value }) })
    })
    this.tail = result.then(() => undefined, () => undefined)
    this.remembered.set(command.id, { fingerprint, result })
    while (this.remembered.size > this.maxRememberedCommands) {
      const oldest = this.remembered.keys().next().value as string | undefined
      if (oldest == null) break
      this.remembered.delete(oldest)
    }
    return result
  }

  dispose() {
    this.disposed = true
    this.remembered.clear()
  }
}

export const createNetworkRuleControlHandler = (store: NetworkMockRuleStore): RuntimeControlHandler => value => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeControlError('runtime_control.invalid_command')
  }
  const record = value as unknown as { expectedRevision?: unknown; rules?: unknown }
  if (record.expectedRevision != null && typeof record.expectedRevision !== 'string') {
    throw new RuntimeControlError('runtime_control.invalid_command')
  }
  const snapshot = store.replace(record.rules as NetworkMockRuleSet, record.expectedRevision as string | undefined)
  return JSON.parse(JSON.stringify(snapshot)) as NativeJsonValue
}
