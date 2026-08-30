import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import type { PreparedChildProcessAbortSignalV1 } from './guest-child-process-abort.js'

export type ChildProcessEnvironmentScopeV1 = 'processTree' | 'runtime'

export interface ChildProcessEnvironmentConfigurationV1 {
  readonly allowedScopes: readonly ChildProcessEnvironmentScopeV1[]
  readonly defaultScope: ChildProcessEnvironmentScopeV1
}

export const childProcessEnvironmentV1 = Symbol('holo.childProcessEnvironment')

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
  done: Function,
  signal?: PreparedChildProcessAbortSignalV1
) => {
  const stdout: Uint8Array[] = []
  const stderr: Uint8Array[] = []
  let resourceError: Error | undefined
  let aborted = false
  ;(resource.stdout as Record<string, Function> | null)?.on('data', (chunk: Uint8Array) => stdout.push(chunk))
  ;(resource.stderr as Record<string, Function> | null)?.on('data', (chunk: Uint8Array) => stderr.push(chunk))
  ;(resource as Record<string, Function>).once('error', (error: unknown) => {
    resourceError = error instanceof Error ? error : new Error('Controlled child process failed')
  })
  let removeAbortListener = () => {}
  if (signal != null) {
    const markAborted = () => {
      aborted = true
    }
    removeAbortListener = () => signal.remove(markAborted)
    if (signal.readAborted()) markAborted()
    else signal.add(markAborted)
  }
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
    removeAbortListener()
    const error = aborted
      ? Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR', name: 'AbortError' })
      : resourceError ?? (code === 0
        ? null
        : Object.assign(new Error(`Process exited with code ${String(code)}`), { code, signal }))
    done(error, output(stdout), output(stderr))
  })
}
