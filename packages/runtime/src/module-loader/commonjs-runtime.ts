import { HolonomyModuleLoaderError } from './errors.js'

const DEFINE = Object.defineProperty
const APPLY = Reflect.apply
const CHAR = String.prototype.charCodeAt
const LAST_INDEX = String.prototype.lastIndexOf
const SLICE = String.prototype.slice
const TYPE_ERROR = TypeError

export interface CommonJsModuleStateV1 {
  exports: unknown
  filename: string
  id: string
  loaded: boolean
  path: string
}

export interface CommonJsRequireV1 {
  (specifier: unknown): unknown
  main: CommonJsModuleStateV1 | undefined
  resolve(specifier: unknown): string
}

export const createCommonJsModuleStateV1 = (
  url: string,
  entry: boolean,
  exports: unknown
): CommonJsModuleStateV1 => ({
  exports,
  filename: url,
  id: entry ? '.' : url,
  loaded: false,
  path: APPLY(SLICE, url, [0, APPLY(LAST_INDEX, url, ['/'])]) as string
})

const specifierValue = (value: unknown): string => {
  if (typeof value !== 'string') {
    const error = new TYPE_ERROR('The module id must be a string')
    DEFINE(error, 'code', { configurable: true, enumerable: true, value: 'ERR_INVALID_ARG_TYPE', writable: true })
    throw error
  }
  for (let index = 0; index < value.length; index++) {
    const unit = APPLY(CHAR, value, [index]) as number
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = APPLY(CHAR, value, [++index]) as number
      if (next >= 0xDC00 && next <= 0xDFFF) continue
    } else if (unit < 0xDC00 || unit > 0xDFFF) continue
    throw new HolonomyModuleLoaderError('ERR_HOLONOMY_MODULE_INVALID_URL', 'Module id must be Unicode scalar text')
  }
  return value
}

/** JS owns the callable shape; the engine supplies only admitted graph lookups. */
export const createCommonJsRequireV1 = (
  load: (specifier: string) => unknown,
  resolve: (specifier: string) => string,
  main: CommonJsModuleStateV1 | undefined
): CommonJsRequireV1 => {
  const require = function require(specifier: unknown) {
    return load(specifierValue(specifier))
  } as CommonJsRequireV1
  DEFINE(require, 'resolve', {
    configurable: true,
    enumerable: true,
    value: function resolveModule(specifier: unknown) {
      return resolve(specifierValue(specifier))
    },
    writable: true
  })
  DEFINE(require, 'main', { configurable: true, enumerable: true, value: main, writable: true })
  return require
}
