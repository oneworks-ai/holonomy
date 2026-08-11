import { PROCESS_TERMINAL_STATES } from './constants.mjs'
import { serviceError } from './errors.mjs'

const listEmulators = async service => {
  try {
    return await service.core.listEmulators()
  } catch (error) {
    if (error?.code === 'service.unsupported') return []
    throw serviceError('service.unavailable', 'Owned Android emulator inventory is unavailable')
  }
}

export const activeOwnedResourceCount = async service => {
  const snapshot = service.core.snapshot().resources
  const processes = Object.values(snapshot.processes)
    .filter(processRecord => !PROCESS_TERMINAL_STATES.has(processRecord.state)).length
  const inspectors = Object.values(snapshot.inspectors)
    .filter(value => !['closed', 'failed', 'lost'].includes(value.state)).length
  const emulators = await listEmulators(service)
  return processes + inspectors + emulators.filter(value => value.managed && value.state === 'running').length
}

export const drainOwnedResources = async (service, drainProcesses) => {
  const snapshot = service.core.snapshot().resources
  const processes = Object.values(snapshot.processes)
    .filter(processRecord => !PROCESS_TERMINAL_STATES.has(processRecord.state))
  if (processes.length > 0) await drainProcesses(processes)
  const inspectors = Object.values(service.core.snapshot().resources.inspectors)
    .filter(value => !['closed', 'failed', 'lost'].includes(value.state))
  for (const inspector of inspectors) {
    await service.core.closeInspector(
      inspector.id,
      inspector.generation,
      `service-drain:inspector:${inspector.id}:${inspector.generation}`
    )
  }
  const emulators = (await listEmulators(service)).filter(value => value.managed && value.state === 'running')
  for (const emulator of emulators) {
    await service.core.stopEmulator(
      emulator.id,
      `service-drain:emulator:${emulator.id}:${emulator.ownerNonce ?? 'owned'}`
    )
  }
}
