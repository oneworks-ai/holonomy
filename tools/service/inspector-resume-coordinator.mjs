import { serviceError } from './errors.mjs'

const RESUME_METHOD = 'Runtime.runIfWaitingForDebugger'

export class InspectorResumeCoordinator {
  #handler
  #pending = new WeakMap()

  configure(handler) {
    if (typeof handler !== 'function') {
      throw serviceError('service.invalid_request', 'Inspector resume handler is invalid')
    }
    this.#handler = handler
  }

  async afterResponse(lease, message, response) {
    if (message.method !== RESUME_METHOD || response?.error != null || this.#handler == null) return response
    let pending = this.#pending.get(lease)
    if (pending == null) {
      pending = Promise.resolve().then(() =>
        this.#handler({
          generation: lease.generation,
          idempotencyKey: `inspector-resume:${lease.inspectorId}:${lease.generation}`,
          inspectorId: lease.inspectorId,
          processId: lease.processId
        })
      )
      this.#pending.set(lease, pending)
    }
    await pending
    return response
  }
}
