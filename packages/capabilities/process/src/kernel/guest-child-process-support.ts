import { copyInspectedBytes, inspectBytes } from '@holonomyjs/runtime/crypto/binary-intrinsics'
import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import { sha256HexOwnedBytes } from '@holonomyjs/runtime/module-loader/sha256'

export type ChildProcessEnvironmentScopeV1 = 'processTree' | 'runtime'

export interface ChildProcessEnvironmentConfigurationV1 {
  readonly allowedScopes: readonly ChildProcessEnvironmentScopeV1[]
  readonly defaultScope: ChildProcessEnvironmentScopeV1
}

export const childProcessEnvironmentV1 = Symbol.for('holo.childProcessEnvironment')

const DEFAULT_CHILD_PROCESS_ENVIRONMENT_V1: ChildProcessEnvironmentConfigurationV1 = Object.freeze({
  allowedScopes: Object.freeze(['processTree'] as const),
  defaultScope: 'processTree'
})

export const invalidChildProcessValueV1 = (message: string): never => {
  const error = new TypeError(message)
  Object.defineProperty(error, 'code', { enumerable: true, value: 'ERR_INVALID_ARG_VALUE' })
  throw error
}
export const childProcessInvalidStateV1 = () => {
  const error = new Error('ERR_INVALID_STATE: controlled child process stdin is closed')
  Object.defineProperty(error, 'code', { enumerable: true, value: 'ERR_INVALID_STATE' })
  return error
}
export const childProcessAbortErrorV1 = () =>
  Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR', name: 'AbortError' })
const MAX_STDIN_INPUT_BYTES = 16 * 1024 * 1024
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const encodeOwnedBytes = (bytes: Uint8Array, length: number): string => {
  let output = ''
  for (let index = 0; index < length; index += 3) {
    const first = bytes[index]!
    const second = index + 1 < length ? bytes[index + 1]! : 0
    const third = index + 2 < length ? bytes[index + 2]! : 0
    const packed = (first << 16) | (second << 8) | third
    output += BASE64_ALPHABET[(packed >> 18) & 0x3F]
    output += BASE64_ALPHABET[(packed >> 12) & 0x3F]
    output += index + 1 < length ? BASE64_ALPHABET[(packed >> 6) & 0x3F] : '='
    output += index + 2 < length ? BASE64_ALPHABET[packed & 0x3F] : '='
  }
  return output
}
export const snapshotChildProcessStdinDataV1 = (value: unknown): JsonValueV1 => {
  if (typeof value === 'string') return value
  try {
    const snapshot = inspectBytes(value)
    if (snapshot.byteLength > MAX_STDIN_INPUT_BYTES) {
      return invalidChildProcessValueV1('Child process stdin data exceeds the v1 byte limit')
    }
    const bytes = copyInspectedBytes(snapshot)
    return {
      base64: encodeOwnedBytes(bytes, snapshot.byteLength),
      byteLength: snapshot.byteLength,
      sha256: sha256HexOwnedBytes(bytes, snapshot.byteLength)
    }
  } catch {
    return invalidChildProcessValueV1('Child process stdin data must be a fixed Uint8Array view')
  }
}
export const childProcessRecordV1 = (value: unknown): Record<string, unknown> => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidChildProcessValueV1('Options must be an object')
  }
  return value as Record<string, unknown>
}
export const childProcessCallbackV1 = (value: unknown): (...args: unknown[]) => unknown =>
  typeof value === 'function'
    ? value as (...args: unknown[]) => unknown
    : invalidChildProcessValueV1('Callback must be a function')
export const optionalChildProcessCallbackV1 = (value: unknown) =>
  value == null ? undefined : childProcessCallbackV1(value)

export const snapshotChildProcessOptionsV1 = (
  value: unknown,
  shell: boolean,
  exec: boolean,
  environmentConfiguration: ChildProcessEnvironmentConfigurationV1 = DEFAULT_CHILD_PROCESS_ENVIRONMENT_V1
): Readonly<{ environmentScope: ChildProcessEnvironmentScopeV1; options: JsonValueV1 }> => {
  const source = (value == null ? {} : childProcessRecordV1(value)) as Record<PropertyKey, unknown>
  const allowed = exec
    ? ['cwd', 'encoding', 'env', 'maxBuffer', 'signal', 'timeout']
    : ['cwd', 'env', 'shell', 'signal', 'stdio', 'timeout']
  if (Object.keys(source).some(key => !allowed.includes(key))) {
    return invalidChildProcessValueV1('Unsupported child process option')
  }
  const symbols = Object.getOwnPropertySymbols(source)
  if (symbols.some(symbol => symbol !== childProcessEnvironmentV1)) {
    return invalidChildProcessValueV1('Unsupported child process option')
  }
  const environmentDescriptor = Object.getOwnPropertyDescriptor(source, childProcessEnvironmentV1)
  if (environmentDescriptor != null && !('value' in environmentDescriptor)) {
    return invalidChildProcessValueV1('Invalid child process environment')
  }
  const environmentScope = environmentDescriptor == null
    ? environmentConfiguration.defaultScope
    : (() => {
      const request = childProcessRecordV1(environmentDescriptor.value)
      if (Object.keys(request).length !== 1 || typeof request.scope !== 'string') {
        return invalidChildProcessValueV1('Invalid child process environment')
      }
      return request.scope as ChildProcessEnvironmentScopeV1
    })()
  if (
    !['processTree', 'runtime'].includes(environmentConfiguration.defaultScope) ||
    environmentConfiguration.allowedScopes.length === 0 ||
    environmentConfiguration.allowedScopes.some(scope => !['processTree', 'runtime'].includes(scope)) ||
    new Set(environmentConfiguration.allowedScopes).size !== environmentConfiguration.allowedScopes.length ||
    !environmentConfiguration.allowedScopes.includes(environmentConfiguration.defaultScope) ||
    !environmentConfiguration.allowedScopes.includes(environmentScope)
  ) return invalidChildProcessValueV1('Child process environment is unavailable')
  if (source.signal != null && typeof source.signal !== 'object') {
    return invalidChildProcessValueV1('Invalid child process signal')
  }
  const output: Record<string, JsonValueV1> = {}
  for (const key of allowed) {
    if (key === 'signal' || source[key] === undefined) continue
    const outputKey = key === 'timeout' ? 'timeoutMs' : key === 'maxBuffer' ? 'maxBufferBytes' : key
    output[outputKey] = source[key] as JsonValueV1
  }
  if (shell) output.shell = true
  return Object.freeze({ environmentScope, options: output })
}

export const snapshotChildProcessArgsV1 = (value: unknown) => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    return invalidChildProcessValueV1('Arguments must be strings')
  }
  return [...value]
}

export const shellQuoteV1 = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export const collectChildProcessOutputV1 = (
  resource: Record<string, unknown>,
  encoding: unknown,
  done: Function
) => {
  const stdout: Uint8Array[] = []
  const stderr: Uint8Array[] = []
  let resourceError: Error | undefined
  ;(resource.stdout as Record<string, Function> | null)?.on('data', (chunk: Uint8Array) => stdout.push(chunk))
  ;(resource.stderr as Record<string, Function> | null)?.on('data', (chunk: Uint8Array) => stderr.push(chunk))
  ;(resource as Record<string, Function>).once('error', (error: unknown) => {
    resourceError = error instanceof Error ? error : new Error('Controlled child process failed')
  })
  const output = (chunks: Uint8Array[]) => {
    const size = chunks.reduce((total, item) => total + item.byteLength, 0)
    const merged = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return encoding === 'utf8' ? new TextDecoder().decode(merged) : merged
  }
  ;(resource as Record<string, Function>).once('close', (code: unknown, signal: unknown) => {
    const error = resourceError ?? (code === 0
      ? null
      : Object.assign(new Error(`Process exited with code ${String(code)}`), { code, signal }))
    done(error, output(stdout), output(stderr))
  })
}
