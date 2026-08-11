import type { InstalledRuntimeConsole, RuntimeConsole, RuntimeConsoleHostPort, RuntimeConsoleLevel } from './types.js'

const ARRAY_IS_ARRAY = Array.isArray
const MATH_MIN = Math.min
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor
const REFLECT_APPLY = Reflect.apply
const STRING = String
const STRING_SLICE = String.prototype.slice
const SYMBOL_DESCRIPTION = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(Symbol.prototype, 'description')?.get
const MAX_ARGUMENTS = 64
const MAX_MESSAGE_CODE_UNITS = 64 * 1024
const TRUNCATION = '…'

const truncate = (value: string, limit: number) =>
  value.length <= limit
    ? value
    : `${
      REFLECT_APPLY(STRING_SLICE, value, [0, limit > TRUNCATION.length ? limit - TRUNCATION.length : 0])
    }${TRUNCATION}`

const formatValue = (value: unknown, limit: number) => {
  if (typeof value === 'string') return truncate(value, limit)
  if (typeof value === 'bigint') return '[BigInt]'
  if (typeof value === 'symbol') {
    const description = SYMBOL_DESCRIPTION == null
      ? undefined
      : REFLECT_APPLY(SYMBOL_DESCRIPTION, value, []) as string | undefined
    return description == null ? 'Symbol()' : `Symbol(${truncate(description, limit - 8)})`
  }
  if (typeof value === 'function') return '[Function]'
  if (value == null || typeof value !== 'object') return STRING(value)
  try {
    return ARRAY_IS_ARRAY(value) ? '[Array]' : '[Object]'
  } catch {
    return '[Uninspectable]'
  }
}

export const createRuntimeConsole = (host: RuntimeConsoleHostPort): InstalledRuntimeConsole => {
  if (host == null || typeof host.write !== 'function') throw new TypeError('Runtime console host is invalid')
  const write = host.write.bind(host)
  const emit = (level: RuntimeConsoleLevel, values: readonly unknown[]) => {
    let output = ''
    const count = MATH_MIN(values.length, MAX_ARGUMENTS)
    for (let index = 0; index < count && output.length < MAX_MESSAGE_CODE_UNITS; index += 1) {
      if (index > 0) output += ' '
      output += formatValue(values[index], MAX_MESSAGE_CODE_UNITS - output.length)
    }
    if (values.length > count && output.length < MAX_MESSAGE_CODE_UNITS) {
      output += `${output.length === 0 ? '' : ' '}${TRUNCATION}`
    }
    output = truncate(output, MAX_MESSAGE_CODE_UNITS)
    try {
      write(level, output)
    } catch {
      // Console transport failures must not expose host details to guest code.
    }
  }
  const global: RuntimeConsole = Object.freeze({
    debug: (...values: unknown[]) => emit('debug', values),
    error: (...values: unknown[]) => emit('error', values),
    info: (...values: unknown[]) => emit('info', values),
    log: (...values: unknown[]) => emit('log', values),
    warn: (...values: unknown[]) => emit('warn', values)
  })
  return Object.freeze({
    global,
    syntheticModule: Object.freeze({ ...global, default: global })
  })
}
