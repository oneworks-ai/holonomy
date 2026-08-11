import { access } from 'node:fs/promises'
import process from 'node:process'

import { serviceError } from './errors.mjs'
import { atomicWriteJson, readJsonFile } from './state-files.mjs'
import { tokensEqual } from './validation.mjs'

export const cleanAvdName = output =>
  output.split('\n').map(value => value.trim())
    .filter(value => value !== '' && value !== 'OK')[0]

export const parseEmulatorSerials = output =>
  output.split('\n').slice(1)
    .map(line => line.trim().split(/\s+/u))
    .filter(([serial, state]) => serial?.startsWith('emulator-') && state === 'device')
    .map(([serial]) => serial)

export const readActiveEmulators = async (run, adb) => {
  const output = await run(adb, ['devices'], { timeoutMs: 10_000 })
  const entries = await Promise.all(
    parseEmulatorSerials(output).map(async serial => {
      const name = cleanAvdName(
        await run(adb, ['-s', serial, 'emu', 'avd', 'name'], {
          timeoutMs: 10_000
        }).catch(() => '')
      )
      if (name == null) return undefined
      const ownerNonce = (await run(
        adb,
        ['-s', serial, 'shell', 'getprop', 'qemu.holonomy.owner_nonce'],
        { timeoutMs: 10_000 }
      ).catch(() => '')).trim()
      return [name, { ownerNonce, serial }]
    })
  )
  return new Map(entries.filter(Boolean))
}

export const processIsAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export const readProcessCommand = async (run, pid, ps, platform = process.platform) => {
  if (!['darwin', 'linux'].includes(platform) || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    const command = await run(ps ?? '/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      timeoutMs: 10_000
    })
    return command.trim() || undefined
  } catch {
    return undefined
  }
}

export const matchesEmulatorLauncher = (command, owner) => {
  if (typeof command !== 'string') return false
  const tokens = command.trim().split(/\s+/u).map(value => value.replace(/^["']|["']$/gu, ''))
  const executable = tokens[0] ?? ''
  if (!/(?:^|\/)(?:emulator|qemu-system-[\w.-]+)$/u.test(executable)) return false
  const hasPair = (name, value) => tokens.some((token, index) => token === name && tokens[index + 1] === value)
  return hasPair('-avd', owner.id) &&
    hasPair('-prop', `qemu.holonomy.owner_nonce=${owner.ownerNonce}`)
}

export const verifyEmulatorOwner = async (id, owner, activeOwner, operations) => {
  if (owner.serial !== activeOwner?.serial || !operations.isProcessAlive(owner.launcherPid)) return false
  let command
  try {
    command = await operations.readProcessCommand(owner.launcherPid)
  } catch {
    return false
  }
  if (!matchesEmulatorLauncher(command, { id, ownerNonce: owner.ownerNonce })) return false
  return activeOwner.ownerNonce === '' || tokensEqual(activeOwner.ownerNonce, owner.ownerNonce)
}

export const requireEmulatorExecutable = async emulator => {
  if (emulator == null) throw serviceError('service.unsupported', 'Android emulator SDK is unavailable')
  try {
    await access(emulator)
    return emulator
  } catch {
    throw serviceError('service.unsupported', 'Android emulator SDK is unavailable')
  }
}

export const loadEmulatorOwners = async stateFile => {
  if (stateFile == null) return new Map()
  const state = await readJsonFile(stateFile)
  if (state == null) return new Map()
  if (state.version !== 1 || !Array.isArray(state.owners) || state.owners.length > 64) {
    throw serviceError('service.state_corrupt', 'Android emulator ownership state is invalid')
  }
  const owners = new Map()
  for (const owner of state.owners) {
    if (
      typeof owner?.id !== 'string' || typeof owner.ownerNonce !== 'string' ||
      !Number.isSafeInteger(owner.launcherPid) || typeof owner.serial !== 'string'
    ) throw serviceError('service.state_corrupt', 'Android emulator ownership state is invalid')
    owners.set(owner.id, owner)
  }
  return owners
}

export const persistEmulatorOwners = async (stateFile, managed) => {
  if (stateFile == null) return
  const owners = [...managed.entries()].filter(([, owner]) => owner.serial != null).map(([id, owner]) => ({
    id,
    launcherPid: owner.launcherPid,
    ownerNonce: owner.ownerNonce,
    serial: owner.serial
  }))
  await atomicWriteJson(stateFile, { owners, version: 1 }, 64 * 1024)
}
