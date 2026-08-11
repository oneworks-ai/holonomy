import { serviceError } from './errors.mjs'

const PACKAGE = 'ai.oneworks.holonomy.e2e'
const ACTIVITY = `${PACKAGE}/.HolonomyRuntimeActivity`
const STORE = 'no_backup/holonomy/session-v2'

const abortReason = signal =>
  signal.reason ?? serviceError('service.unavailable', 'Android session command was cancelled')

const throwIfAborted = signal => {
  if (signal?.aborted) throw abortReason(signal)
}

const awaitWithAbort = async (pending, signal) => {
  if (signal == null) return await pending
  throwIfAborted(signal)
  return await new Promise((resolve, reject) => {
    let abort
    const settle = callback => value => {
      signal.removeEventListener('abort', abort)
      callback(value)
    }
    abort = () => settle(reject)(abortReason(signal))
    signal.addEventListener('abort', abort, { once: true })
    pending.then(settle(resolve), settle(reject))
  })
}

const pause = async signal => {
  throwIfAborted(signal)
  await new Promise((resolve, reject) => {
    let abort
    let timer
    const finish = callback => value => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      callback(value)
    }
    abort = () => finish(reject)(abortReason(signal))
    timer = setTimeout(finish(resolve), 100)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

const waitForReply = async options => {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(options.signal)
    let output
    try {
      output = await awaitWithAbort(
        options.execute(options.adb, [
          '-s',
          options.serial,
          'shell',
          'run-as',
          PACKAGE,
          'cat',
          `${STORE}/replies/${options.commandId}.reply`
        ], { signal: options.signal, timeoutMs: options.timeoutMs }),
        options.signal
      )
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal)
    }
    if (output?.trim()) return JSON.parse(output)
    await pause(options.signal)
  }
  throw serviceError('service.unavailable', 'Android session command timed out')
}

export const submitStoredAndroidCommand = async options => {
  try {
    await options.execute(options.adb, [
      '-s',
      options.serial,
      'shell',
      'run-as',
      PACKAGE,
      'mkdir',
      '-p',
      `${STORE}/commands`,
      `${STORE}/replies`,
      `${STORE}/states`,
      `${STORE}/results`,
      `${STORE}/outputs`,
      `${STORE}/control`
    ], { signal: options.signal, timeoutMs: options.timeoutMs })
    await options.execute(options.adb, [
      '-s',
      options.serial,
      'shell',
      'run-as',
      PACKAGE,
      'tee',
      `${STORE}/commands/${options.commandId}.command`
    ], { input: JSON.stringify(options.command), signal: options.signal, timeoutMs: options.timeoutMs })
    await options.execute(options.adb, [
      '-s',
      options.serial,
      'shell',
      'am',
      'start',
      '-W',
      '-n',
      ACTIVITY,
      '--es',
      'ai.oneworks.holonomy.session.extra.COMMAND_ID',
      options.commandId
    ], { signal: options.signal, timeoutMs: options.timeoutMs })
    return await waitForReply(options)
  } finally {
    await options.execute(options.adb, [
      '-s',
      options.serial,
      'shell',
      'run-as',
      PACKAGE,
      'rm',
      '-f',
      `${STORE}/commands/${options.commandId}.command`,
      `${STORE}/replies/${options.commandId}.reply`
    ], { timeoutMs: options.timeoutMs }).catch(() => undefined)
  }
}
