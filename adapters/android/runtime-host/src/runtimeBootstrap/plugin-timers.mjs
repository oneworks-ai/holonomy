export const installAndroidPluginTimers = host => {
  const timers = new Map()
  Object.defineProperties(globalThis, {
    clearTimeout: {
      configurable: false,
      enumerable: false,
      value: timerId => {
        if (!Number.isSafeInteger(timerId) || timerId <= 0) return
        timers.delete(timerId)
        host.cancelTimer(timerId)
      },
      writable: false
    },
    setTimeout: {
      configurable: false,
      enumerable: false,
      value: (callback, delay = 0, ...args) => {
        if (typeof callback !== 'function') throw new TypeError('Timer callback must be a function')
        const milliseconds = Number(delay)
        if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > Number.MAX_SAFE_INTEGER) {
          throw new TypeError('Timer delay must be a finite non-negative number')
        }
        const timerId = host.scheduleTimer(Math.trunc(milliseconds))
        timers.set(timerId, () => callback(...args))
        return timerId
      },
      writable: false
    }
  })
  globalThis.__oneworksAndroidPluginTimer = timerId => {
    const callback = timers.get(timerId)
    if (callback == null) return
    timers.delete(timerId)
    callback()
  }
  return () => {
    for (const timerId of timers.keys()) host.cancelTimer(timerId)
    timers.clear()
  }
}
