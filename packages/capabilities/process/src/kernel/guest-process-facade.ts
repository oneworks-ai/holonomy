import type {
  CapabilityGuestBridgeV1,
  CapabilityGuestConfigurationV1
} from '@holonomyjs/runtime/kernel/guest-facade-support'
import {
  createCapabilityRequestV1,
  createCapabilitySyntheticBindingV1,
  readCapabilityTerminalV1
} from '@holonomyjs/runtime/kernel/guest-facade-support'

type Listener = (...args: unknown[]) => unknown
const APPLY = Reflect.apply

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
  const request = (member: string) => bridge.invokeSync(createCapabilityRequestV1('node:process', member, 'sync', {}))
  const read = (member: string) => readCapabilityTerminalV1(request(member))
  const property = (member: string) => {
    const terminal = request(member)
    try {
      return Object.freeze({ value: readCapabilityTerminalV1(terminal), denied: undefined })
    } catch (error) {
      if (!(error instanceof Error) || Object.getOwnPropertyDescriptor(error, 'code')?.value !== 'ERR_ACCESS_DENIED') {
        throw error
      }
      return Object.freeze({ value: undefined, denied: Object.freeze(error) })
    }
  }
  const environment = property('env')
  const env = Object.freeze(Object.assign(Object.create(null) as Record<string, string>, environment.value ?? {}))
  const execPath = property('execPath')
  const pid = property('pid')
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
    env,
    exit(code = exitCode) {
      if (!Number.isSafeInteger(code) || code < 0 || code > 255) return invalid('Invalid process exit code')
      if (configuration.processControl == null) return invalid('process.exit is unsupported')
      configuration.processControl.exit(code)
      throw new Error('Holonomy process exited')
    },
    kill: unsupported('kill'),
    nextTick(callback: Listener, ...args: unknown[]) {
      if (typeof callback !== 'function') {
        const error = new TypeError('The "callback" argument must be of type function')
        Object.defineProperty(error, 'code', { enumerable: true, value: 'ERR_INVALID_ARG_TYPE' })
        throw error
      }
      const schedule = configuration.processControl?.nextTick
      if (schedule == null) return invalid('process.nextTick is unsupported')
      schedule(() => APPLY(callback, undefined, args))
    },
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
  for (const [name, snapshot] of [['pid', pid], ['execPath', execPath]] as const) {
    Object.defineProperty(api, name, {
      enumerable: true,
      get() {
        if (snapshot.denied != null) throw snapshot.denied
        return snapshot.value
      }
    })
  }
  const process = Object.freeze(api)
  // ESM cells are data snapshots; default properties preserve read-time denial.
  // Do not spread the default object and accidentally invoke denied getters.
  const namespace = Object.freeze(Object.assign(
    Object.fromEntries(
      Object.keys(process).map(
        name => [name, name === 'pid' ? pid.value : name === 'execPath' ? execPath.value : process[name]]
      )
    ),
    { default: process }
  ))
  return createCapabilitySyntheticBindingV1(namespace, Object.keys(namespace))
}
