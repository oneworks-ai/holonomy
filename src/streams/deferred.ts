export interface Deferred<Value> {
  readonly promise: Promise<Value>
  reject: (reason?: unknown) => void
  resolve: (value: Value | PromiseLike<Value>) => void
}

export const createDeferred = <Value>(): Deferred<Value> => {
  let reject!: (reason?: unknown) => void
  let resolve!: (value: Value | PromiseLike<Value>) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    reject = rejectPromise
    resolve = resolvePromise
  })
  void promise.catch(() => undefined)
  return { promise, reject, resolve }
}
