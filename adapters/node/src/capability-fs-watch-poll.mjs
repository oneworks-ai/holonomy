import nodeFs from 'node:fs'
import nodePath from 'node:path'

const POLL_INTERVAL_MS = 125

const stamp = value => [value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].join(':')

const staleTarget = () => Object.assign(new Error('Filesystem watch target changed'), { code: 'ESTALE' })

const targetIdentity = target => {
  const value = nodeFs.lstatSync(target, { bigint: true })
  if (value.isSymbolicLink()) throw staleTarget()
  return [value.dev, value.ino]
}

const snapshot = (target, expected) => {
  // One no-follow stat is enough to validate the object whose metadata is
  // observed. Never enumerate a mutable pathname: it could be rebound to an
  // unauthorized directory between a precheck and readdir.
  const value = nodeFs.lstatSync(target, { bigint: true })
  if (value.isSymbolicLink() || value.dev !== expected[0] || value.ino !== expected[1]) {
    throw staleTarget()
  }
  return stamp(value)
}

// Native fs.watch remains the primary wakeup. The bounded snapshot also makes
// delivery possible when a Host filesystem emits no native watch callbacks.
export const createFsWatchPollV1 = (target, { directory, persistent, onChange, onError }) => {
  const resolvedTarget = nodeFs.realpathSync.native(target)
  const expected = targetIdentity(resolvedTarget)
  let previous = snapshot(resolvedTarget, expected)
  let closed = false
  let timer
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
  }
  const poll = () => {
    if (closed) return -1
    let next
    try {
      next = snapshot(resolvedTarget, expected)
    } catch (error) {
      close()
      onError(error)
      return -1
    }
    const before = previous
    previous = next
    if (before === next) return 0
    onChange('change', directory ? null : nodePath.basename(target))
    return 1
  }
  timer = setInterval(poll, POLL_INTERVAL_MS)
  if (!persistent) timer.unref()
  return { close, poll }
}

export const createFsWatchSourceV1 = (target, { directory, persistent, onChange, onError }) => {
  let closed = false
  const poller = createFsWatchPollV1(target, { directory, persistent, onChange, onError })
  let watcher
  try {
    watcher = nodeFs.watch(target, { persistent }, () => {
      if (closed) return
      // FSWatcher does not expose its bound inode. A path can be rebound
      // between opening the polling baseline and installing fs.watch, so
      // neither the native filename nor an unchanged native event is trusted.
      poller.poll()
    })
  } catch (error) {
    poller.close()
    throw error
  }
  watcher.once('error', error => {
    if (!closed) onError(error)
  })
  return {
    close() {
      if (closed) return
      closed = true
      poller.close()
      watcher.close()
    }
  }
}
