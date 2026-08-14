import type { CapabilityGuestBridgeV1, CapabilityGuestConfigurationV1 } from './guest-facade-support.js'
import {
  createCapabilityRequestV1,
  createCapabilitySyntheticBindingV1,
  readCapabilityTerminalV1
} from './guest-facade-support.js'

type Listener = (...args: unknown[]) => unknown

const invalid = (message: string): never => {
  const error = new TypeError(message)
  Object.defineProperty(error, 'code', { enumerable: true, value: 'ERR_INVALID_ARG_VALUE' })
  throw error
}

export const createCapabilityProcessOverrideV1 = (
  configuration: CapabilityGuestConfigurationV1,
  bridge: CapabilityGuestBridgeV1
) => {
  const base = configuration.process
  if (base == null) return undefined
  const read = (member: string) =>
    readCapabilityTerminalV1(
      bridge.invokeSync(createCapabilityRequestV1('node:process', member, 'sync', {}))
    )
  const listeners = new Map<string | symbol, Set<Listener>>()
  let exitCode = 0
  const api: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const unsupported = (member: string) => () => invalid(`process.${member} is unsupported`)
  const on = (event: string | symbol, listener: Listener) => {
    if (typeof listener !== 'function') return invalid('Process listener must be a function')
    let values = listeners.get(event)
    if (values == null) {
      values = new Set()
      listeners.set(event, values)
    }
    values.add(listener)
    return api
  }
  Object.assign(api, {
    abort: unsupported('abort'),
    addListener: on,
    arch: base.arch,
    argv: Object.freeze([...base.argv]),
    chdir: unsupported('chdir'),
    cwd: () => read('cwd'),
    emit(event: string | symbol, ...args: unknown[]) {
      let emitted = false
      for (const listener of listeners.get(event) ?? []) {
        emitted = true
        listener(...args)
      }
      return emitted
    },
    env: read('env'),
    execPath: read('execPath'),
    exit(code = exitCode) {
      if (!Number.isSafeInteger(code) || code < 0 || code > 255) return invalid('Invalid process exit code')
      if (configuration.processControl == null) return invalid('process.exit is unsupported')
      configuration.processControl.exit(code)
      throw new Error('Holonomy process exited')
    },
    kill: unsupported('kill'),
    nextTick: unsupported('nextTick'),
    off(event: string | symbol, listener: Listener) {
      listeners.get(event)?.delete(listener)
      return api
    },
    on,
    once(event: string | symbol, listener: Listener) {
      const wrapped = (...args: unknown[]) => {
        listeners.get(event)?.delete(wrapped)
        listener(...args)
      }
      return on(event, wrapped)
    },
    pid: read('pid'),
    platform: base.platform,
    removeListener(event: string | symbol, listener: Listener) {
      listeners.get(event)?.delete(listener)
      return api
    },
    setgid: unsupported('setgid'),
    setuid: unsupported('setuid'),
    stderr: Object.freeze({ write: (chunk: unknown) => configuration.stdio?.write('stderr', chunk) !== false }),
    stdout: Object.freeze({ write: (chunk: unknown) => configuration.stdio?.write('stdout', chunk) !== false }),
    umask: unsupported('umask'),
    versions: Object.freeze({ ...base.versions })
  })
  Object.defineProperty(api, 'exitCode', {
    enumerable: true,
    get: () => exitCode,
    set(value: unknown) {
      if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 255) {
        return invalid('Invalid process exit code')
      }
      exitCode = Number(value)
    }
  })
  Object.defineProperty(api, 'default', { enumerable: true, value: api })
  Object.freeze(api)
  return createCapabilitySyntheticBindingV1(api, Object.keys(api))
}
