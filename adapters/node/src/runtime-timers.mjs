export const cancelRuntimeTimer = (timers, timerId) => {
  const timer = timers.get(timerId)
  if (timer == null) return
  timers.delete(timerId)
  if (timer.interval) clearInterval(timer.handle)
  else clearTimeout(timer.handle)
}
