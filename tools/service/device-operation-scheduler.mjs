export class DeviceOperationScheduler {
  #controllers = new Map()
  #deviceTails = new Map()
  #tasks = new Set()

  schedule(deviceId, operationId, work) {
    const controller = new AbortController()
    this.#controllers.set(operationId, controller)
    const previous = this.#deviceTails.get(deviceId) ?? Promise.resolve()
    const task = previous.then(() => work(controller.signal), () => work(controller.signal))
    const consumed = task.catch(() => undefined).finally(() => {
      this.#controllers.delete(operationId)
      this.#tasks.delete(consumed)
      if (this.#deviceTails.get(deviceId) === consumed) this.#deviceTails.delete(deviceId)
    })
    this.#deviceTails.set(deviceId, consumed)
    this.#tasks.add(consumed)
  }

  cancel(operationId) {
    const controller = this.#controllers.get(operationId)
    if (controller == null) return false
    controller.abort()
    return true
  }

  async close() {
    for (const controller of this.#controllers.values()) controller.abort()
    await Promise.allSettled([...this.#tasks])
  }
}
