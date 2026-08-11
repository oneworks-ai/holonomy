import { androidSerialOf } from './android-target-support.mjs'

const reversePortOf = process => {
  try {
    const url = new URL(process.launch?.env?.HOLONOMY_FIXTURE_URL)
    const port = Number(url.port)
    return url.hostname === '127.0.0.1' && Number.isSafeInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

export const reconcileAndroidRuntime = async (commandPort, process, signal) => {
  const serial = androidSerialOf(process)
  const cleanupLeases = async () => {
    if (typeof commandPort.cleanupProcess === 'function') {
      await commandPort.cleanupProcess(process.id, process.generation)
      return
    }
    const reversePort = reversePortOf(process)
    if (reversePort != null) await commandPort.removeReverse(serial, reversePort)
  }
  let status
  try {
    status = await commandPort.command(serial, {
      command: 'status',
      expectedGeneration: null,
      runtimeId: process.id
    }, { signal })
  } catch (error) {
    if (error?.code === 'service.not_found') {
      await cleanupLeases()
      return { cleaned: true }
    }
    return { deferred: true }
  }
  let generation = status.ack.generation
  try {
    const stopped = await commandPort.command(serial, {
      command: 'stop',
      expectedGeneration: generation,
      reason: 'service_restart_cleanup',
      runtimeId: process.id
    }, { signal })
    generation = stopped.ack.generation
    await commandPort.command(serial, {
      command: 'dispose',
      expectedGeneration: generation,
      runtimeId: process.id
    }, { signal })
    await cleanupLeases()
    return { cleaned: true }
  } catch (error) {
    if (error?.code === 'service.not_found') {
      await cleanupLeases()
      return { cleaned: true }
    }
    return { deferred: true }
  }
}
