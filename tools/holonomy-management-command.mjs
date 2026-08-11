import { randomUUID } from 'node:crypto'

import { createClient, followProcess, openProcessInspector, writeJson } from './holonomy-managed-command.mjs'
import { parseHolonomyManagementArgs } from './holonomy-management-options.mjs'
import { ensureHolonomyServiceProcess } from './service/service-process.mjs'

const requireGeneration = async (client, processId, expectedGeneration) => {
  if (expectedGeneration != null) return expectedGeneration
  return (await client.call(`/v1/processes/${encodeURIComponent(processId)}`)).generation
}

const ensureManagementClient = async (command, dependencies) => {
  return await createClient(command.options, dependencies, command.group !== 'service')
}

export const runHolonomyManagementCommand = async (command, io, dependencies = {}) => {
  const client = await ensureManagementClient(command, dependencies)
  if (command.group === 'service') {
    if (command.action === 'start') {
      if (command.options.openapi !== 'auto') throw new Error('A remote Holonomy Service cannot be started locally')
      return writeJson(
        io,
        await (dependencies.ensureService ?? ensureHolonomyServiceProcess)({
          client,
          host: command.options.listen,
          port: command.options.port,
          tlsCert: command.options.tlsCert,
          tlsKey: command.options.tlsKey
        })
      )
    }
    if (command.action === 'status') return writeJson(io, await client.status())
    if (command.action === 'stop') {
      return writeJson(
        io,
        await client.call('/v1/service:shutdown', {
          body: { drain: command.options.drain },
          headers: { 'idempotency-key': randomUUID() },
          method: 'POST'
        })
      )
    }
    return writeJson(
      io,
      await client.call('/v1/service/token:rotate', {
        body: {},
        headers: { 'idempotency-key': randomUUID() },
        method: 'POST'
      })
    )
  }
  if (command.group === 'device') {
    await client.call('/v1/devices:refresh', { method: 'POST' })
    const value = command.action === 'list'
      ? await client.call('/v1/devices')
      : await client.call(`/v1/devices/${encodeURIComponent(command.id)}`)
    return writeJson(io, value)
  }
  if (command.group === 'emulator') {
    if (command.action === 'list') return writeJson(io, await client.call('/v1/emulators'))
    const id = command.action === 'start' ? command.options.avd : command.id
    return writeJson(
      io,
      await client.call(`/v1/emulators/${encodeURIComponent(id)}:${command.action}`, {
        body: {},
        headers: { 'idempotency-key': randomUUID() },
        method: 'POST'
      })
    )
  }
  if (command.action === 'list') return writeJson(io, await client.call('/v1/processes'))
  if (command.action === 'show') {
    return writeJson(io, await client.call(`/v1/processes/${encodeURIComponent(command.id)}`))
  }
  if (command.action === 'logs') {
    if (!command.options.follow) {
      return writeJson(io, await client.readLogs(command.id, { after: command.options.after, limit: 1_024 }))
    }
    const process = await followProcess(client, command.id, io, {
      ...dependencies,
      timeoutMs: dependencies.followTimeoutMs ?? 24 * 60 * 60 * 1_000
    })
    return writeJson(io, process)
  }
  const generation = await requireGeneration(client, command.id, command.options.expectedGeneration)
  if (command.action === 'remove') {
    return writeJson(io, await client.removeProcess(command.id, generation, randomUUID()))
  }
  if (command.action === 'inspect') {
    return writeJson(
      io,
      await openProcessInspector(
        client,
        { generation, id: command.id },
        { openDevTools: command.options.devtools },
        dependencies
      )
    )
  }
  return writeJson(io, await client.processAction(command.id, command.action, generation, randomUUID()))
}

export const parseAndRunHolonomyManagementCommand = async (input, io, dependencies = {}) => {
  const command = parseHolonomyManagementArgs(input)
  if (command == null) return undefined
  await runHolonomyManagementCommand(command, io, dependencies)
  return 0
}
