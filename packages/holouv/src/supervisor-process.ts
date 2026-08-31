import type {
  ProcessBackendProcessSinkV1,
  ProcessBackendProcessV1,
  ProcessSupervisorOperationV1
} from '@holonomyjs/capability-process'

export interface HoloUvSupervisorConnectionV1 {
  readonly command: (
    operation: Extract<ProcessSupervisorOperationV1, 'signal' | 'stdin' | 'stdinClose'>,
    processId: number,
    payload?: string | Uint8Array
  ) => Promise<void>
}

export class HoloUvSupervisorProcessV1 implements ProcessBackendProcessV1 {
  readonly #connection: HoloUvSupervisorConnectionV1
  readonly #sequence = { stderr: 0, stdout: 0 }
  readonly #sink: ProcessBackendProcessSinkV1
  #closed = false
  #exited = false
  readonly processId: number

  constructor(
    connection: HoloUvSupervisorConnectionV1,
    processId: number,
    sink: ProcessBackendProcessSinkV1
  ) {
    this.#connection = connection
    this.processId = processId
    this.#sink = sink
  }

  close(code: number | null, signal: string | null): void {
    if (this.#closed) return
    if (!this.#exited) this.exit(code, signal)
    this.#closed = true
    this.#sink.close(code, signal)
  }

  closeStdin(): Promise<void> {
    return this.#connection.command('stdinClose', this.processId)
  }

  error(error: Error): void {
    if (!this.#closed) this.#sink.error(error)
  }

  exit(code: number | null, signal: string | null): void {
    if (this.#exited) return
    this.#exited = true
    this.#sink.exit(code, signal)
  }

  fail(error: Error): void {
    if (this.#closed) return
    this.#sink.error(error)
    this.close(null, null)
  }

  signal(signal: string): Promise<void> {
    return this.#connection.command('signal', this.processId, signal)
  }

  stream(stream: 'stderr' | 'stdout', sequence: number, chunk: Uint8Array): void {
    if (this.#closed || sequence !== this.#sequence[stream]) {
      throw new TypeError('Invalid HoloUV supervisor stream sequence')
    }
    this.#sequence[stream] += 1
    this.#sink[stream](chunk)
  }

  writeStdin(chunk: Uint8Array): Promise<void> {
    return this.#connection.command('stdin', this.processId, Uint8Array.from(chunk))
  }
}
