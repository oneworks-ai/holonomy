import { Buffer } from 'node:buffer'
import vm from 'node:vm'

const MAX_LOG_RECORDS = 256
const MAX_LOG_TEXT_UNITS = 16 * 1024

const INSTALL_RUNTIME_GLOBALS = `(() => {
  const records = []
  const stringify = value => {
    let text
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value)
    } catch {
      text = '[unserializable]'
    }
    if (text === undefined) text = String(value)
    return text.length > ${MAX_LOG_TEXT_UNITS} ? text.slice(0, ${MAX_LOG_TEXT_UNITS}) : text
  }
  const write = (level, values) => {
    if (records.length >= ${MAX_LOG_RECORDS}) return
    records.push(Object.freeze({ level, text: values.map(stringify).join(' ') }))
  }
  const runtimeConsole = Object.freeze({
    debug(...values) { write('debug', values) },
    error(...values) { write('error', values) },
    info(...values) { write('info', values) },
    log(...values) { write('log', values) },
    warn(...values) { write('warn', values) }
  })
  Object.defineProperty(globalThis, 'console', {
    configurable: true,
    enumerable: true,
    value: runtimeConsole,
    writable: false
  })
  return Object.freeze({
    drain() { return records.splice(0, records.length) },
    parseNativeEvent(json) {
      const event = JSON.parse(json)
      if (Array.isArray(event.binary)) {
        for (const handle of event.binary) {
          const source = handle.dataBase64.replace(/=+$/u, '')
          const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
          const bytes = []
          let buffer = 0
          let bits = 0
          for (const character of source) {
            const digit = alphabet.indexOf(character)
            if (digit < 0) throw new TypeError('Invalid native binary')
            buffer = (buffer << 6) | digit
            bits += 6
            if (bits >= 8) {
              bits -= 8
              bytes.push((buffer >> bits) & 0xFF)
            }
          }
          handle.data = new Uint8Array(bytes)
          delete handle.dataBase64
        }
      }
      return event
    },
    parseFrozen(json) {
      const value = JSON.parse(json)
      const freeze = current => {
        if (current !== null && typeof current === 'object') {
          for (const child of Object.values(current)) freeze(child)
          Object.freeze(current)
        }
        return current
      }
      return freeze(value)
    }
  })
})()`

export function createRuntimeContext(name = 'holonomy-runtime') {
  const sandbox = Object.create(null)
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
    name
  })
  const controls = vm.runInContext(INSTALL_RUNTIME_GLOBALS, context, {
    filename: 'holonomy:///runtime/context-bootstrap.mjs'
  })
  return Object.freeze({ context, controls })
}

export function createContextValue(runtimeContext, value) {
  return runtimeContext.controls.parseFrozen(JSON.stringify(value))
}

export function drainRuntimeLogs(runtimeContext) {
  return runtimeContext.controls.drain().map(record => ({ level: record.level, text: record.text }))
}

export function createNativeEventValue(runtimeContext, event) {
  const serializable = event.binary == null
    ? event
    : {
      ...event,
      binary: event.binary.map(handle => ({
        dataBase64: Buffer.from(handle.data.buffer, handle.data.byteOffset, handle.data.byteLength).toString('base64'),
        handle: handle.handle
      }))
    }
  return runtimeContext.controls.parseNativeEvent(JSON.stringify(serializable))
}

const HOST_FACADE_SOURCE = `(() => {
  const call = (name, ...args) => dispatch(name, args)
  return Object.freeze({
    cancelNative: (...args) => call('cancelNative', ...args),
    cancelTimer: (...args) => call('cancelTimer', ...args),
    closeNativeResource: (...args) => call('closeNativeResource', ...args),
    configuration: () => call('configuration'),
    disposeNative: () => call('disposeNative'),
    grantNativeCredits: (...args) => call('grantNativeCredits', ...args),
    installSyntheticModules: (...args) => call('installSyntheticModules', ...args),
    nativeDispatch: (...args) => call('nativeDispatch', ...args),
    networkDiagnostic: (...args) => call('networkDiagnostic', ...args),
    now: () => call('now'),
    readModule: (...args) => call('readModule', ...args),
    registerDispose: (...args) => call('registerDispose', ...args),
    registerRuleUpdater: (...args) => call('registerRuleUpdater', ...args),
    registerTimerFire: (...args) => call('registerTimerFire', ...args),
    registerTurn: (...args) => call('registerTurn', ...args),
    requestWakeup: (...args) => call('requestWakeup', ...args),
    scheduleTimer: (...args) => call('scheduleTimer', ...args),
    sha256Chunks: (...args) => call('sha256Chunks', ...args),
    terminate: (...args) => call('terminate', ...args),
    writeOutput: (...args) => call('writeOutput', ...args)
  })
})()`

export function installRuntimeHostBridge(runtimeContext, operations) {
  const dispatch = (name, args) => {
    try {
      const operation = operations[name]
      return typeof operation === 'function' ? operation(...args) : null
    } catch (error) {
      operations.onError?.(name, error)
      return null
    }
  }
  const factory = vm.compileFunction(`return ${HOST_FACADE_SOURCE}`, [], {
    contextExtensions: [Object.freeze({ dispatch })],
    filename: 'holonomy:///runtime/node-host-facade.mjs',
    parsingContext: runtimeContext.context
  })
  const facade = factory()
  Object.defineProperty(runtimeContext.context, '__holonomyNodeHost', {
    configurable: true,
    enumerable: false,
    value: facade,
    writable: false
  })
}
