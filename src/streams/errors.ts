export type RuntimeStreamErrorCode =
  | 'ERR_HOLONOMY_STREAM_ABORTED'
  | 'ERR_HOLONOMY_STREAM_INVALID_ARGUMENT'
  | 'ERR_HOLONOMY_STREAM_INVALID_STATE'
  | 'ERR_HOLONOMY_STREAM_NOT_SUPPORTED'
  | 'ERR_HOLONOMY_STREAM_PREMATURE_CLOSE'

export class RuntimeStreamError extends Error {
  readonly code: RuntimeStreamErrorCode

  constructor(code: RuntimeStreamErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'RuntimeStreamError'
  }
}

export const invalidStreamArgument = (message: string): RuntimeStreamError =>
  new RuntimeStreamError('ERR_HOLONOMY_STREAM_INVALID_ARGUMENT', message)

export const invalidStreamState = (message: string): RuntimeStreamError =>
  new RuntimeStreamError('ERR_HOLONOMY_STREAM_INVALID_STATE', message)

export const streamNotSupported = (feature: string): RuntimeStreamError =>
  new RuntimeStreamError(
    'ERR_HOLONOMY_STREAM_NOT_SUPPORTED',
    `${feature} is not supported by the Holonomy Runtime`
  )

export const streamAborted = (): RuntimeStreamError =>
  new RuntimeStreamError('ERR_HOLONOMY_STREAM_ABORTED', 'The stream was aborted')

export const streamPrematureClose = (): RuntimeStreamError =>
  new RuntimeStreamError(
    'ERR_HOLONOMY_STREAM_PREMATURE_CLOSE',
    'The stream closed before completing'
  )

export const toStreamError = (
  reason: unknown,
  fallback: () => RuntimeStreamError
): Error => reason instanceof Error ? reason : fallback()

export const toWebStreamError = (reason: unknown): unknown => reason === undefined ? streamAborted() : reason
