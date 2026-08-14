import { randomUUID } from 'node:crypto'

import { openHolonomyDevTools } from './holonomy-devtools-launcher.mjs'
import { prepareHolonomyLaunchSnapshot } from './holonomy-launch-snapshot.mjs'
import { startHolonomyPluginWatch } from './holonomy-plugin-watch.mjs'
import { createHolonomyServiceClient } from './service/service-client.mjs'
import { ensureHolonomyServiceProcess } from './service/service-process.mjs'

const TERMINAL_STATES = new Set(['cancelled', 'exited', 'failed', 'lost'])
const OPERATION_TERMINAL_STATES = new Set(['cancelled', 'failed', 'succeeded'])

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export const writeJson = (io, value) => io.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

export const createClient = async (options, dependencies, ensure = true) => {
  const baseUrl = options.openapi === 'auto' ? undefined : new URL(options.openapi).origin
  const client = (dependencies.createClient ?? createHolonomyServiceClient)({
    baseUrl,
    tokenFile: options.openapiTokenFile
  })
  if (ensure) {
    await (dependencies.ensureService ?? ensureHolonomyServiceProcess)({
      baseUrl,
      client,
      tokenFile: options.openapiTokenFile
    })
  }
  return client
}

export const waitForOperation = async (client, operationId, options = {}) => {
  const deadline = (options.now ?? Date.now)() + (options.timeoutMs ?? 30_000)
  while ((options.now ?? Date.now)() < deadline) {
    const operation = await client.call(`/v1/operations/${encodeURIComponent(operationId)}`)
    if (OPERATION_TERMINAL_STATES.has(operation.state)) {
      if (operation.state !== 'succeeded') throw new Error(`Holonomy operation ${operation.state}`)
      return operation
    }
    await (options.pause ?? pause)(50)
  }
  throw new Error('Holonomy operation timed out')
}

const refreshAndSelectDevice = async (client, options) => {
  const devices = await client.call('/v1/devices:refresh', { body: {}, method: 'POST' })
  if (options.target === 'node') {
    const local = devices.find(device => device.id === 'node:local' && device.state === 'online')
    if (local == null) throw new Error('The local Node Holonomy host is unavailable')
    return local
  }
  const online = devices.filter(device => device.platform === 'android' && device.state === 'online')
  if (options.serial != null) {
    const selected = online.find(device => device.id === options.serial || device.serial === options.serial)
    if (selected == null) throw new Error(`Android device is unavailable: ${options.serial}`)
    return selected
  }
  if (online.length !== 1) throw new Error('Select one Android device with --device')
  return online[0]
}

const printLogEvents = (io, events) => {
  for (const event of events) {
    const output = event.stream === 'stderr' || event.stream === 'error' ? io.stderr : io.stdout
    const chunk = String(event.chunk ?? '')
    output.write(chunk.endsWith('\n') ? chunk : `${chunk}\n`)
  }
}

export const followProcess = async (client, processId, io, options = {}) => {
  const deadline = (options.now ?? Date.now)() + options.timeoutMs
  let cursor = 0
  while ((options.now ?? Date.now)() < deadline) {
    const logs = await client.readLogs(processId, { after: cursor, limit: 256, waitMs: 250 })
    printLogEvents(io, logs.events ?? [])
    cursor = logs.cursor ?? cursor
    const process = await client.call(`/v1/processes/${encodeURIComponent(processId)}`)
    if (TERMINAL_STATES.has(process.state)) return process
  }
  const process = await client.call(`/v1/processes/${encodeURIComponent(processId)}`)
  if (!TERMINAL_STATES.has(process.state)) {
    await client.processAction(process.id, 'stop', process.generation, randomUUID())
  }
  throw new Error('Holonomy runtime process timed out')
}

export const openProcessInspector = async (client, process, options, dependencies = {}) => {
  const admitted = await client.openInspector(
    process.id,
    process.generation,
    randomUUID(),
    options.openDevTools === true
  )
  await waitForOperation(client, admitted.value.operation.id, dependencies)
  const inspector = await client.call(`/v1/inspectors/${encodeURIComponent(admitted.value.inspector.id)}`)
  if (options.openDevTools === true) {
    const open = dependencies.openDevTools ?? openHolonomyDevTools
    open(inspector.devtoolsFrontendUrl)
  }
  return inspector
}

export const runHolonomyRuntimeCommand = async (parsed, io, dependencies = {}) => {
  const client = await createClient(parsed.options, dependencies)
  const device = await refreshAndSelectDevice(client, parsed.options)
  const snapshot = (dependencies.prepareLaunch ?? prepareHolonomyLaunchSnapshot)(parsed.command, parsed.options)
  const admitted = await client.launchProcess({
    ...(snapshot.capabilityRuntime == null ? {} : { capabilityRuntime: snapshot.capabilityRuntime }),
    deviceId: device.id,
    entryUrl: snapshot.entryUrl,
    ...(snapshot.fixture == null ? {} : { fixture: snapshot.fixture }),
    ...(snapshot.networkRuleSet == null ? {} : { initialNetworkRuleSet: snapshot.networkRuleSet }),
    inspectorMode: snapshot.inspectorMode,
    isolation: snapshot.isolation,
    launch: snapshot.launch,
    ...(snapshot.runtimePlugins == null ? {} : { runtimePlugins: snapshot.runtimePlugins }),
    sandboxPolicy: snapshot.sandboxPolicy,
    target: snapshot.target
  }, randomUUID())
  const process = admitted.value.process
  if (parsed.options.detach) {
    writeJson(io, { generation: process.generation, processId: process.id, state: process.state })
    return 0
  }
  await waitForOperation(client, admitted.value.operation.id, {
    ...dependencies,
    timeoutMs: parsed.options.timeoutMs
  })
  let current = await client.call(`/v1/processes/${encodeURIComponent(process.id)}`)
  if (parsed.options.openDevTools) {
    await openProcessInspector(client, current, parsed.options, dependencies)
  }
  const pluginWatch = parsed.options.watch
    ? (dependencies.startPluginWatch ?? startHolonomyPluginWatch)({
      client,
      configPath: snapshot.pluginConfigPath,
      dependencies: { ...dependencies, waitForOperation },
      io,
      pluginRoots: parsed.options.pluginRoots,
      process: current,
      runtimePlugins: snapshot.runtimePlugins
    })
    : undefined
  try {
    current = await followProcess(client, process.id, io, {
      ...dependencies,
      timeoutMs: parsed.options.timeoutMs
    })
  } finally {
    await pluginWatch?.close()
  }
  const code = current.exit?.code ?? (current.state === 'exited' ? 0 : 1)
  return parsed.options.allowFailures ? 0 : code
}
