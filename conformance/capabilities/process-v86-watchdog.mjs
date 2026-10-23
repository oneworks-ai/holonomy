// Conformance bounds only. These do not grant authority or define a production SLA.
const startupTimeoutMs = 300_000
const maxExecutionTimeMs = 120_000
const transportMarginMs = 5_000
const cleanupGraceMs = 15_000
const maxVmRootStarts = 12
const setupTeardownMarginMs = 60_000
const watchdogMs = startupTimeoutMs + maxExecutionTimeMs + transportMarginMs
const suiteWaitMs = maxVmRootStarts * (watchdogMs + cleanupGraceMs) + setupTeardownMarginMs
const startWaitMs = startupTimeoutMs + transportMarginMs

export const v86TestBudget = Object.freeze({
  cleanupGraceMs,
  // The restart instrumentation case runs the shared suite twice.
  instrumentationTimeoutMs: 2 * (startWaitMs + suiteWaitMs) + setupTeardownMarginMs,
  maxExecutionTimeMs,
  maxVmRootStarts,
  setupTeardownMarginMs,
  startWaitMs,
  startupTimeoutMs,
  suiteWaitMs,
  transportMarginMs,
  watchdogMs
})

/** First select timeout failure, then kill, then await close within a finite grace. */
export const watchV86Child = (label, start, budget = v86TestBudget) =>
  new Promise((resolve, reject) => {
    let child
    let settled = false
    let timeoutError
    let watchdogTimer
    let graceTimer
    let cleanups = []
    const cleanup = () => {
      let failed = false
      let error
      const attempt = release => {
        try {
          release()
        } catch (failure) {
          if (!failed) {
            failed = true
            error = failure
          }
        }
      }
      attempt(() => clearTimeout(watchdogTimer))
      attempt(() => clearTimeout(graceTimer))
      const registered = cleanups
      cleanups = []
      for (let index = 0; index < registered.length; index++) attempt(registered[index])
      return { error, failed }
    }
    const finish = (failed, value) => {
      if (settled) return
      settled = true
      let released
      try {
        released = cleanup()
      } catch (error) {
        released = { error, failed: true }
      }
      if (failed) reject(value)
      else if (released.failed) reject(released.error)
      else resolve(value)
    }
    const scope = {
      on(emitter, event, callback) {
        let active = true
        const listener = (...args) => {
          if (active && !settled && (!timeoutError || event === 'close')) callback(...args)
        }
        emitter.on(event, listener)
        const release = () => {
          active = false
          // Full and minimal facades both support logical deactivation here;
          // local removal does not release the physical Host resource.
          const remove = typeof emitter.removeListener === 'function' ? emitter.removeListener : emitter.off
          if (typeof remove === 'function') Reflect.apply(remove, emitter, [event, listener])
        }
        if (settled) release()
        else cleanups.push(release)
      },
      reject(error) {
        if (!timeoutError) finish(true, error)
      },
      resolve(value) {
        if (!timeoutError) finish(false, value)
      },
      setTimeout(callback, delay) {
        const timer = setTimeout(() => {
          if (!settled && !timeoutError) callback()
        }, delay)
        if (settled) clearTimeout(timer)
        else cleanups.push(() => clearTimeout(timer))
        return timer
      }
    }
    watchdogTimer = setTimeout(() => {
      if (settled) return
      timeoutError = new Error(`Timed out waiting for ${label}`)
      graceTimer = setTimeout(() => finish(true, timeoutError), budget.cleanupGraceMs)
      try {
        child.kill('SIGKILL')
      } catch {
        // A failed kill must still end in the selected timeout within grace.
      }
    }, budget.watchdogMs)
    try {
      child = start(scope)
      if (!settled) {
        scope.on(child, 'close', () => {
          if (timeoutError) finish(true, timeoutError)
        })
      }
    } catch (error) {
      scope.reject(error)
    }
  })
