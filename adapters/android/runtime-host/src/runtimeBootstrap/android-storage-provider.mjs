import { createHostStorageProvider } from '@holonomyjs/capability-storage/host/storage-provider'
import { WebAbortController } from './modules/web-network/web-abort.js'

/** Async engine transport only; shared Host provider owns Policy, staging and results. */
export const createAndroidStorageProvider = (host, policy) => {
  const configuration = typeof host.nativeConfiguration === 'function' ? JSON.parse(host.nativeConfiguration()) : null
  const installation = configuration?.storage
  if (installation == null || !configuration.capabilities?.includes('host.storage.v1')) return null
  let nextJob = 1
  const jobs = new Map()
  const callers = new Map()
  const native = {
    storageStart(command) {
      const id = nextJob++
      if (!Number.isSafeInteger(id)) throw new Error('Storage transport exhausted')
      const token = JSON.parse(command).callToken
      let resolve
      const promise = new Promise(accept => {
        resolve = accept
      })
      jobs.set(id, { resolve, token })
      if (host.storageStart(id, command) !== true) {
        jobs.delete(id)
        throw new Error('Storage IO was not admitted')
      }
      return { id, promise }
    },
    storageCancel(id) {
      const job = jobs.get(id)
      if (job != null) {
        jobs.delete(id)
        try {
          host.storageCancel(job.token)
        } finally {
          job.resolve(JSON.stringify({ value: { ok: false, error: { code: 'storage.cancelled' } } }))
        }
      }
    }
  }
  const provider = createHostStorageProvider(native, installation, policy ?? { access: 'none' })
  return Object.freeze({
    provider: provider.provider,
    completeNative(id, terminal) {
      const job = jobs.get(id)
      if (job == null) return
      jobs.delete(id)
      job.resolve(terminal)
    },
    dispatch(token, request, kernel) {
      if (callers.has(token)) throw new Error('Duplicate Storage call')
      const controller = new WebAbortController()
      callers.set(token, controller)
      void provider.dispatch(JSON.parse(request), token, controller.signal, kernel)
        .then(
          terminal => host.emitStorageGuest(token, JSON.stringify(terminal)),
          () =>
            host.emitStorageGuest(token, JSON.stringify({ value: { ok: false, error: { code: 'storage.internal' } } }))
        )
        .finally(() => callers.delete(token))
        .catch(() => undefined)
    },
    cancel(token) {
      callers.get(token)?.abort()
    },
    close() {
      for (const controller of callers.values()) controller.abort()
      provider.close()
      for (const job of jobs.values()) {
        job.resolve(JSON.stringify({ value: { ok: false, error: { code: 'storage.cancelled' } } }))
      }
      callers.clear()
      jobs.clear()
    }
  })
}
