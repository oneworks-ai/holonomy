export class KeyedOperationQueue {
  #tails = new Map()

  async schedule(id, work) {
    const previous = this.#tails.get(id) ?? Promise.resolve()
    const task = previous.then(work, work)
    const consumed = task.catch(() => undefined).finally(() => {
      if (this.#tails.get(id) === consumed) this.#tails.delete(id)
    })
    this.#tails.set(id, consumed)
    return await task
  }
}
