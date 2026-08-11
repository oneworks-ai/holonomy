import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { findAdb, resolveAndroidSdkRoot } from '../android-devtools-adb.mjs'
import { executeAndroidCommand } from './android-command-port.mjs'
import {
  loadEmulatorOwners,
  persistEmulatorOwners,
  processIsAlive,
  readActiveEmulators,
  readProcessCommand,
  requireEmulatorExecutable,
  verifyEmulatorOwner
} from './android-emulator-support.mjs'
import { serviceError } from './errors.mjs'
import { KeyedOperationQueue } from './keyed-operation-queue.mjs'

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export class AndroidEmulatorManager {
  #adb
  #emulator
  #isProcessAlive
  #managed = new Map()
  #loaded = false
  #pollIntervalMs
  #queue = new KeyedOperationQueue()
  #readProcessCommand
  #run
  #spawn
  #stateFile
  #timeoutMs

  constructor(options = {}) {
    this.#adb = options.adb ?? findAdb()
    const sdkRoot = options.sdkRoot ?? resolveAndroidSdkRoot(
      this.#adb,
      options.environment,
      options.homeDirectory ?? homedir()
    )
    this.#emulator = options.emulator ?? (sdkRoot == null ? undefined : join(sdkRoot, 'emulator', 'emulator'))
    this.#pollIntervalMs = options.pollIntervalMs ?? 250
    this.#run = options.run ?? executeAndroidCommand
    this.#readProcessCommand = options.readProcessCommand ?? (
      async pid => await readProcessCommand(this.#run, pid, options.ps)
    )
    this.#spawn = options.spawn ?? spawn
    this.#stateFile = options.stateFile
    this.#timeoutMs = options.emulatorTimeoutMs ?? 120_000
    this.#isProcessAlive = options.isProcessAlive ?? processIsAlive
  }

  async listEmulators() {
    await this.#load()
    const emulator = await this.#requireEmulator()
    const installed = (await this.#run(emulator, ['-list-avds'], { timeoutMs: 10_000 }))
      .split('\n').map(value => value.trim()).filter(Boolean)
    const active = await this.#activeEmulators()
    const identifiers = new Set([...installed, ...active.keys()])
    let changed = false
    const result = await Promise.all(
      [...identifiers].sort().map(async id => {
        const activeOwner = active.get(id)
        const serial = activeOwner?.serial
        let owner = this.#managed.get(id)
        const verified = owner != null && serial != null && await this.#verifyOwner(id, owner, activeOwner)
        if (owner != null && serial == null && !this.#isProcessAlive(owner.launcherPid)) {
          this.#managed.delete(id)
          owner = undefined
          changed = true
        }
        return Object.freeze({
          id,
          managed: verified,
          ...(verified ? { ownerNonce: owner.ownerNonce } : {}),
          ...(serial == null ? {} : { serial }),
          state: serial == null ? 'stopped' : 'running'
        })
      })
    )
    if (changed) await this.#persist()
    return result
  }

  async startEmulator(input) {
    return await this.#queue.schedule(input.id, async () => await this.#start(input.id, input.options ?? {}))
  }

  async stopEmulator(input) {
    return await this.#queue.schedule(input.id, async () => await this.#stop(input.id))
  }

  async restartEmulator(input) {
    return await this.#queue.schedule(input.id, async () => {
      await this.#stop(input.id)
      return await this.#start(input.id, input.options ?? {})
    })
  }

  async close() {
    await this.#load()
    await Promise.allSettled([...this.#managed.keys()].map(id => this.stopEmulator({ id })))
  }

  async #start(id, options) {
    const inventory = await this.listEmulators()
    const candidate = inventory.find(value => value.id === id)
    if (candidate == null) throw serviceError('service.not_found', 'Android virtual device was not found')
    if (candidate.state === 'running') {
      if (!candidate.managed) throw serviceError('service.conflict', 'Android emulator is not owned by this service')
      return candidate
    }
    const previousOwner = this.#managed.get(id)
    if (previousOwner != null && this.#isProcessAlive(previousOwner.launcherPid)) {
      throw serviceError('service.conflict', 'Android emulator launcher state is not safely observable')
    }
    const emulator = await this.#requireEmulator()
    const ownerNonce = randomBytes(16).toString('hex')
    const args = [
      '-avd',
      id,
      '-no-snapshot-save',
      '-prop',
      `qemu.holonomy.owner_nonce=${ownerNonce}`
    ]
    if (options.coldBoot === true) args.push('-no-snapshot-load')
    if (options.wipeData === true) args.push('-wipe-data')
    const child = this.#spawn(emulator, args, { detached: false, stdio: 'ignore' })
    this.#managed.set(id, { child, launcherPid: child.pid, ownerNonce })
    child.unref?.()
    try {
      const serial = (await this.#waitFor(id, true)).serial
      this.#managed.set(id, { child, launcherPid: child.pid, ownerNonce, serial })
      await this.#persist()
      return Object.freeze({ id, managed: true, ownerNonce, serial, state: 'running' })
    } catch (error) {
      this.#managed.delete(id)
      child.kill?.('SIGTERM')
      throw error
    }
  }

  async #stop(id) {
    await this.#load()
    const owner = this.#managed.get(id)
    if (owner == null) throw serviceError('service.conflict', 'Android emulator is not owned by this service')
    const activeOwner = (await this.#activeEmulators()).get(id)
    const serial = activeOwner?.serial
    if (serial != null && !await this.#verifyOwner(id, owner, activeOwner)) {
      throw serviceError('service.conflict', 'Android emulator ownership could not be verified')
    }
    if (serial == null && this.#isProcessAlive(owner.launcherPid)) {
      throw serviceError('service.conflict', 'Android emulator launcher state is not safely observable')
    }
    if (serial != null) await this.#run(this.#adb, ['-s', serial, 'emu', 'kill'], { timeoutMs: 10_000 })
    await this.#waitFor(id, false)
    this.#managed.delete(id)
    await this.#persist()
    return Object.freeze({ id, managed: false, state: 'stopped' })
  }

  async #activeEmulators() {
    return await readActiveEmulators(this.#run, this.#adb)
  }

  async #verifyOwner(id, owner, activeOwner) {
    return await verifyEmulatorOwner(id, owner, activeOwner, {
      isProcessAlive: this.#isProcessAlive,
      readProcessCommand: this.#readProcessCommand
    })
  }

  async #waitFor(id, running) {
    const deadline = Date.now() + this.#timeoutMs
    while (Date.now() < deadline) {
      const activeOwner = (await this.#activeEmulators()).get(id)
      if (running === (activeOwner != null)) return activeOwner
      await pause(this.#pollIntervalMs)
    }
    throw serviceError('service.unavailable', 'Android emulator operation timed out')
  }

  async #requireEmulator() {
    return await requireEmulatorExecutable(this.#emulator)
  }

  async #load() {
    if (this.#loaded) return
    this.#loaded = true
    this.#managed = await loadEmulatorOwners(this.#stateFile)
  }

  async #persist() {
    await persistEmulatorOwners(this.#stateFile, this.#managed)
  }
}

export const createAndroidEmulatorManager = options => new AndroidEmulatorManager(options)
