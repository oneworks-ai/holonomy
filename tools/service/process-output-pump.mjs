import { Buffer } from 'node:buffer'

import { serviceError } from './errors.mjs'
import { ingestNetworkOutput } from './network-output-ingest.mjs'

const keyOf = process => `${process.id}:${process.generation}`
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const abortablePause = (milliseconds, signal) =>
  new Promise(resolve => {
    const timer = setTimeout(finish, milliseconds)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })

export class ProcessOutputPump {
  #adapters
  #inspectorProxy
  #logStore
  #maxFailures
  #onTerminalFailure = () => undefined
  #pollIntervalMs
  #publishOutput
  #states = new Map()

  constructor(options) {
    this.#adapters = options.adapterDispatcher
    this.#inspectorProxy = options.inspectorProxy
    this.#logStore = options.logStore
    this.#maxFailures = options.maxFailures ?? 3
    this.#pollIntervalMs = options.pollIntervalMs ?? 100
    this.#publishOutput = options.publishOutput ?? (async () => undefined)
  }

  setFailureHandler(handler) {
    this.#onTerminalFailure = handler
  }

  async open() {
    await this.#logStore.open()
  }

  async start(process) {
    const key = keyOf(process)
    await this.stop(process)
    const controller = new AbortController()
    const state = { controller, cursor: 0, failures: 0, process, task: undefined }
    state.task = this.#run(state).catch(() => undefined).finally(() => {
      if (this.#states.get(key) === state) this.#states.delete(key)
    })
    this.#states.set(key, state)
  }

  async stop(process, options = {}) {
    const state = this.#states.get(keyOf(process))
    if (state == null) return
    state.controller.abort()
    await state.task
    if (options.drain === true) await this.#drain(state)
    this.#states.delete(keyOf(process))
  }

  async remove(process) {
    await this.stop(process)
    await this.#logStore.remove(process.id)
  }

  async captureStartupFailure(process) {
    await this.#drain({ controller: new AbortController(), cursor: 0, process })
  }

  async page(processId, options = {}) {
    const deadline = Date.now() + (options.waitMs ?? 0)
    while (true) {
      const page = this.#logStore.page(processId, options)
      if (page.events.length > 0 || Date.now() >= deadline) return page
      await pause(Math.min(25, Math.max(1, deadline - Date.now())))
    }
  }

  async prune() {
    return await this.#logStore.prune()
  }

  async close() {
    await Promise.allSettled([...this.#states.values()].map(state => this.stop(state.process, { drain: true })))
    await this.#logStore.close()
  }

  async #run(state) {
    while (!state.controller.signal.aborted) {
      try {
        const advanced = await this.#read(state, this.#pollIntervalMs)
        state.failures = 0
        if (!advanced) await abortablePause(this.#pollIntervalMs, state.controller.signal)
      } catch (error) {
        if (state.controller.signal.aborted) return
        state.failures += 1
        if (state.failures >= this.#maxFailures) {
          Promise.resolve(this.#onTerminalFailure(state.process, error)).catch(() => undefined)
          return
        }
        await abortablePause(
          Math.min(1_000, this.#pollIntervalMs * 2 ** (state.failures - 1)),
          state.controller.signal
        )
      }
    }
  }

  async #drain(state) {
    for (let turn = 0; turn < 4; turn += 1) {
      if (!await this.#read(state, 0, { drain: true })) return
    }
  }

  async #read(state, waitMs, options = {}) {
    const output = await this.#adapters.target(state.process.target).readLogs({
      after: state.cursor,
      limit: 256,
      process: state.process,
      ...(options.drain === true ? {} : { signal: state.controller.signal }),
      waitMs
    })
    if (state.controller.signal.aborted && options.drain !== true) return false
    if (
      output == null || !Array.isArray(output.events) || output.events.length > 256 ||
      !Number.isSafeInteger(output.cursor) || output.cursor < state.cursor ||
      Buffer.byteLength(JSON.stringify(output), 'utf8') > 1024 * 1024
    ) throw serviceError('service.unavailable', 'Adapter log response is invalid')
    const previous = state.cursor
    const admitted = output.events.filter(event => (
      Number.isSafeInteger(event?.sequence) && event.sequence > previous && event.sequence <= output.cursor
    ))
    const visible = ingestNetworkOutput(this.#inspectorProxy, state.process, admitted)
      .map(event => ({ ...event, generation: state.process.generation }))
    const appended = visible.length === 0 ? [] : await this.#logStore.appendMany(state.process.id, visible)
    state.cursor = output.cursor
    if (admitted.length > 0) {
      await this.#publishOutput({ admitted, appended, process: state.process, sourceCursor: state.cursor })
    }
    return state.cursor > previous
  }
}
