export class SupervisorProcessV1 {
  #closed = false
  #connection
  #exited = false
  #sequence = { stderr: 0, stdout: 0 }
  #sink

  constructor(connection, processId, sink) {
    this.#connection = connection
    this.processId = processId
    this.#sink = sink
  }

  close(code, signal) {
    if (this.#closed) return
    if (!this.#exited) this.exit(code, signal)
    this.#closed = true
    this.#sink.close(code, signal)
  }

  closeStdin() {
    return this.#connection.command('stdinClose', this.processId, null)
  }

  error(error) {
    if (!this.#closed) this.#sink.error(error)
  }

  exit(code, signal) {
    if (this.#exited) return
    this.#exited = true
    this.#sink.exit(code, signal)
  }

  fail(error) {
    if (this.#closed) return
    this.#sink.error(error)
    this.close(null, null)
  }

  signal(signal) {
    return this.#connection.command('signal', this.processId, signal)
  }

  stream(stream, sequence, chunk) {
    if (this.#closed || sequence !== this.#sequence[stream]) {
      throw new TypeError('Invalid Process supervisor stream sequence')
    }
    this.#sequence[stream] += 1
    this.#sink[stream](chunk)
  }

  writeStdin(chunk) {
    return this.#connection.command('stdin', this.processId, Uint8Array.from(chunk))
  }
}
