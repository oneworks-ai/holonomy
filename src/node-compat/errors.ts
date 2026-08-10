export type RuntimeNodeCoreErrorCode =
  | 'ERR_HOLONOMY_INVALID_ARGUMENT'
  | 'ERR_HOLONOMY_INVALID_ENCODING'
  | 'ERR_HOLONOMY_INVALID_URL'
  | 'ERR_HOLONOMY_NOT_SUPPORTED'
  | 'ERR_HOLONOMY_OUT_OF_BOUNDS'
  | 'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
  | 'ERR_HOLONOMY_STDIO_WRITE_FAILED'
  | 'ERR_HOLONOMY_UNHANDLED_ERROR_EVENT'

export type NodeCompatErrorCode = RuntimeNodeCoreErrorCode

export interface RuntimeNodeCoreSanitizedCause {
  readonly kind: 'host-provider-failure'
  readonly operation: 'stdio.write'
}

export class RuntimeNodeCoreError extends Error {
  readonly code: RuntimeNodeCoreErrorCode
  override readonly cause: RuntimeNodeCoreSanitizedCause | undefined

  constructor(
    code: RuntimeNodeCoreErrorCode,
    message: string,
    cause?: RuntimeNodeCoreSanitizedCause
  ) {
    super(message)
    this.code = code
    this.cause = cause
    this.name = 'RuntimeNodeCoreError'
  }
}

export class NodeCompatError extends RuntimeNodeCoreError {
  constructor(code: NodeCompatErrorCode, message: string) {
    super(code, message)
    this.name = 'NodeCompatError'
  }
}

export const invalidArgument = (name: string, detail?: string): never => {
  throw new NodeCompatError(
    'ERR_HOLONOMY_INVALID_ARGUMENT',
    detail ?? `Invalid Holonomy Runtime argument: ${name}`
  )
}

export const invalidEncoding = (encoding: string): never => {
  throw new NodeCompatError(
    'ERR_HOLONOMY_INVALID_ENCODING',
    `Unsupported Holonomy Runtime Buffer encoding: ${encoding}`
  )
}

export const invalidUrl = (detail: string): never => {
  throw new NodeCompatError('ERR_HOLONOMY_INVALID_URL', detail)
}

export const notSupported = (feature: string): never => {
  throw new NodeCompatError(
    'ERR_HOLONOMY_NOT_SUPPORTED',
    `${feature} is not supported by the Holonomy Runtime`
  )
}

export const outOfBounds = (detail: string): never => {
  throw new NodeCompatError('ERR_HOLONOMY_OUT_OF_BOUNDS', detail)
}

export const createStdioWriteError = (
  stream: 'stderr' | 'stdout'
): RuntimeNodeCoreError =>
  new RuntimeNodeCoreError(
    'ERR_HOLONOMY_STDIO_WRITE_FAILED',
    `Holonomy Runtime ${stream} provider write failed`,
    Object.freeze({ kind: 'host-provider-failure', operation: 'stdio.write' })
  )

export const createResourceExhaustedError = (
  stream: 'stderr' | 'stdout'
): RuntimeNodeCoreError =>
  new RuntimeNodeCoreError(
    'ERR_HOLONOMY_RESOURCE_EXHAUSTED',
    `Holonomy Runtime ${stream} write exceeds the configured byte limit`
  )

export class UnhandledErrorEventError extends NodeCompatError {
  readonly context: unknown

  constructor(context: unknown) {
    super(
      'ERR_HOLONOMY_UNHANDLED_ERROR_EVENT',
      'Unhandled error event in the Holonomy Runtime'
    )
    this.context = context
    this.name = 'UnhandledErrorEventError'
  }
}
