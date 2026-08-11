import { stopAndroidProcessMonitor } from './android-process-monitor.mjs'
import { serviceError } from './errors.mjs'

export const androidSerialOf = process => process.deviceId.replace(/^android:/u, '')
export const androidInspectorSocket = processId => `holonomy.${processId}`.slice(0, 96)

export const requireAndroidRuntime = (records, processId) => {
  const record = records.get(processId)
  if (record == null) throw serviceError('service.not_found', 'Android runtime process was not found')
  return record
}

export const applyAndroidControl = async (commandPort, process, value, signal) => {
  await commandPort.command(androidSerialOf(process), {
    command: 'control',
    expectedGeneration: process.generation,
    operation: 'network.rules.replace',
    runtimeId: process.id,
    value
  }, { signal })
}

export const closeAndroidRecord = async (record, commandPort, reverse) => {
  stopAndroidProcessMonitor(record)
  for (const transport of record.transports.values()) transport.close()
  record.transports.clear()
  if (record.localPort != null) await commandPort.removeForward(record.serial, record.localPort)
  record.localPort = undefined
  record.target = undefined
  if (reverse != null) await commandPort.removeReverse(reverse.serial, reverse.port)
}
