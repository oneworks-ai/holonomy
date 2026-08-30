import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

const backendSource = (name: string): string =>
  readFileSync(
    new URL(`../../../adapters/android/process-backend-v86/src/main/backend/${name}`, import.meta.url),
    'utf8'
  )

const frame = (operation: number, payload: Uint8Array, requestId = 0, processId = 0): Uint8Array => {
  const output = new Uint8Array(24 + payload.length)
  const view = new DataView(output.buffer)
  view.setUint32(0, 20 + payload.length)
  output.set(new TextEncoder().encode('HOLO'), 4)
  output[8] = 1
  output[9] = operation
  view.setUint32(12, requestId)
  view.setUint32(16, processId)
  output.set(payload, 24)
  return output
}

const readyPayload = (flags: number): Uint8Array => {
  const output = new Uint8Array(4)
  new DataView(output.buffer).setUint32(0, flags)
  return output
}

describe('android v86 production backend', () => {
  it('preserves filesystem errno through both Android Runtime Realm terminals', () => {
    const root = new URL('../../../adapters/android/e2e/src/runtimeBootstrap/', import.meta.url)
    const guest = readFileSync(new URL('capability-runtime.mjs', root), 'utf8')
    expect(guest).toContain('Number.isInteger(terminal.error?.errno)')
    expect(guest).toContain('value: terminal.error.errno')
    const host = readFileSync(new URL('plugin-host.mjs', root), 'utf8')
    expect(host).toContain('Number.isInteger(error?.errno)')
    expect(host).toContain('errno: error.errno')
  })

  it('configures the Linux environment before publishing readiness', () => {
    const context = vm.createContext({}) as Record<string, unknown>
    for (
      const name of [
        'shim.mjs',
        'driver-support.mjs',
        'driver-network.mjs',
        'driver-sockets.mjs',
        'fuse-support.mjs',
        'fuse.mjs',
        'driver.mjs'
      ]
    ) {
      vm.runInContext(backendSource(name), context)
    }

    class FakeV86 {
      static instance: FakeV86
      readonly listeners = new Map<string, (value: number) => void>()
      readonly writes: Uint8Array[] = []
      runCount = 0

      constructor() {
        FakeV86.instance = this
      }

      add_listener(name: string, callback: (value: number) => void): void {
        this.listeners.set(name, callback)
      }

      run(): void {
        this.runCount += 1
      }

      serial_send_bytes(_port: number, value: Uint8Array): void {
        this.writes.push(Uint8Array.from(value))
      }
    }

    const start = context.__holoStartV86ProcessBackend as (constructor: typeof FakeV86, source: string) => void
    start(
      FakeV86,
      JSON.stringify({
        capabilityDomains: [],
        environmentId: 'test:1:android-v86',
        execGateTimeoutMs: 30_000,
        executables: [],
        generation: 1,
        hosts: [{ address: '192.168.87.1', hostname: 'example.test' }],
        memoryBytes: 134_217_728,
        network: false,
        policy: {},
        requiredKernelCapabilities: ['process'],
        scope: 'processTree'
      })
    )
    expect(FakeV86.instance.runCount).toBe(0)
    FakeV86.instance.listeners.get('emulator-loaded')!(0)
    expect(FakeV86.instance.runCount).toBe(1)
    const receive = FakeV86.instance.listeners.get('serial1-output-byte')!
    for (const byte of frame(5, readyPayload(1))) receive(byte)

    const takeEvent = context.__holoTakeV86BackendEvent as () => string
    expect(takeEvent()).toBe('')
    expect(FakeV86.instance.writes).toHaveLength(0)
    const runTimers = context.__holoRunV86Timers as () => number
    expect(runTimers()).toBe(1)
    expect(FakeV86.instance.writes).toHaveLength(1)
    const configuration = FakeV86.instance.writes[0]!
    const configurationView = new DataView(configuration.buffer, configuration.byteOffset, configuration.byteLength)
    expect(configuration[9]).toBe(18)
    expect(configuration.slice(24, 28)).toEqual(Uint8Array.of(1, 0, 0, 1))
    expect(configurationView.getUint32(28)).toBe(30_000)

    const requestId = configurationView.getUint32(12)
    for (const byte of frame(1, new Uint8Array(), requestId)) receive(byte)
    expect(JSON.parse(takeEvent())).toEqual({ capabilities: 1, event: 'ready' })
  })

  it('fails closed when the Linux kernel lacks a required capability', () => {
    const context = vm.createContext({}) as Record<string, unknown>
    vm.runInContext(backendSource('shim.mjs'), context)
    vm.runInContext(backendSource('driver-support.mjs'), context)
    vm.runInContext(backendSource('driver-network.mjs'), context)
    vm.runInContext(backendSource('driver-sockets.mjs'), context)
    vm.runInContext(backendSource('fuse-support.mjs'), context)
    vm.runInContext(backendSource('fuse.mjs'), context)
    vm.runInContext(backendSource('driver.mjs'), context)

    class FakeV86 {
      static instance: FakeV86
      readonly listeners = new Map<string, (value: number) => void>()
      runCount = 0

      constructor() {
        FakeV86.instance = this
      }

      add_listener(name: string, callback: (value: number) => void): void {
        this.listeners.set(name, callback)
      }

      run(): void {
        this.runCount += 1
      }

      serial_send_bytes(): void {}
    }

    const start = context.__holoStartV86ProcessBackend as (constructor: typeof FakeV86, source: string) => void
    start(
      FakeV86,
      JSON.stringify({
        capabilityDomains: [],
        environmentId: 'test:1:android-v86',
        execGateTimeoutMs: 30_000,
        executables: [],
        generation: 1,
        hosts: [],
        memoryBytes: 134_217_728,
        network: false,
        policy: {},
        requiredKernelCapabilities: ['process', 'fuse'],
        scope: 'processTree'
      })
    )
    expect(FakeV86.instance.runCount).toBe(0)
    FakeV86.instance.listeners.get('emulator-loaded')!(0)
    expect(FakeV86.instance.runCount).toBe(1)
    const receive = FakeV86.instance.listeners.get('serial1-output-byte')!
    for (const byte of frame(5, readyPayload(1))) receive(byte)

    const takeEvent = context.__holoTakeV86BackendEvent as () => string
    expect(JSON.parse(takeEvent())).toEqual({ code: 'provider.unavailable', event: 'backend-error' })
    const command = context.__holoV86BackendCommand as (source: string) => boolean
    expect(command(JSON.stringify({ operation: 'spawn' }))).toBe(false)
  })

  it('turns a Host filesystem failure into a matching FUSE terminal', async () => {
    const context = vm.createContext({}) as Record<string, unknown>
    vm.runInContext(backendSource('shim.mjs'), context)
    vm.runInContext(backendSource('fuse-support.mjs'), context)
    vm.runInContext(backendSource('fuse.mjs'), context)
    const create = context.__holoCreateV86FuseBridge as () => {
      failure(payload: Uint8Array, errno: number): Uint8Array
    }
    const request = vm.runInContext(
      `(() => {
      const value = new Uint8Array(40)
      const target = new DataView(value.buffer)
      target.setUint32(0, value.byteLength, true)
      target.setUint32(4, 3, true)
      target.setBigUint64(8, 42n, true)
      return value
    })()`,
      context
    ) as Uint8Array
    const terminal = create().failure(request, 13)
    const terminalView = new DataView(terminal.buffer, terminal.byteOffset, terminal.byteLength)
    expect(terminalView.getInt32(4, true)).toBe(-13)
    expect(terminalView.getBigUint64(8, true)).toBe(42n)
  })

  it('translates an absent Host lookup into ENOENT instead of a provider failure', async () => {
    const context = vm.createContext({}) as Record<string, unknown>
    vm.runInContext(backendSource('shim.mjs'), context)
    vm.runInContext(backendSource('fuse-support.mjs'), context)
    vm.runInContext(backendSource('fuse.mjs'), context)
    const lookup = vm.runInContext(
      `(() => {
      const request = new Uint8Array(48)
      const target = new DataView(request.buffer)
      target.setUint32(0, request.length, true)
      target.setUint32(4, 1, true)
      target.setBigUint64(8, 1n, true)
      target.setBigUint64(16, 1n, true)
      target.setUint32(32, 41, true)
      request.set(Uint8Array.of(110, 101, 119, 46, 116, 120, 116, 0), 40)
      return request
    })()`,
      context
    ) as Uint8Array
    const create = context.__holoCreateV86FuseBridge as (
      dispatch: (input: unknown) => Promise<null>
    ) => { handle(payload: Uint8Array, frame: { processId: number }): Promise<Uint8Array> }
    const terminal = await create(async () => null).handle(lookup, { processId: 9 })
    const terminalView = new DataView(terminal.buffer, terminal.byteOffset, terminal.byteLength)
    expect(terminalView.getInt32(4, true)).toBe(-2)
  })

  it('attributes a kernel release with pid zero to the process that opened the handle', async () => {
    const context = vm.createContext({}) as Record<string, unknown>
    vm.runInContext(backendSource('shim.mjs'), context)
    vm.runInContext(backendSource('fuse-support.mjs'), context)
    vm.runInContext(backendSource('fuse.mjs'), context)
    vm.runInContext(
      `
      globalThis.__holoFuseCalls = []
      globalThis.__holoFuseBridge = globalThis.__holoCreateV86FuseBridge(async (input, attribution) => {
        globalThis.__holoFuseCalls.push({ ...input, processId: attribution.processId, source: attribution.source })
        if (input.operation === 'lookup') return { kind: 'file', size: 1 }
        if (input.operation === 'open') return 'host-handle'
        if (input.operation === 'release') return null
        throw new Error('unexpected operation')
      })
      globalThis.__holoFuseRequest = (opcode, nodeId, pid, body) => {
        const output = new Uint8Array(40 + body.length)
        const target = new DataView(output.buffer)
        target.setUint32(0, output.length, true)
        target.setUint32(4, opcode, true)
        target.setBigUint64(8, BigInt(opcode + 1), true)
        target.setBigUint64(16, BigInt(nodeId), true)
        target.setUint32(32, pid, true)
        output.set(body, 40)
        return output
      }
    `,
      context
    )
    const bridge = context.__holoFuseBridge as {
      handle(payload: Uint8Array, frame: { processId: number; source?: unknown }): Promise<Uint8Array>
    }
    const request = context.__holoFuseRequest as (
      opcode: number,
      nodeId: number,
      pid: number,
      body: Uint8Array
    ) => Uint8Array
    const source = Object.freeze({ executableId: 'fixture', resourceId: 'process-1' })
    const lookupName = vm.runInContext('Uint8Array.of(105, 110, 112, 117, 116, 46, 116, 120, 116, 0)', context)
    const lookup = await bridge.handle(request(1, 1, 41, lookupName), { processId: 9, source })
    const lookupView = new DataView(lookup.buffer, lookup.byteOffset, lookup.byteLength)
    const nodeId = Number(lookupView.getBigUint64(16, true))
    const openBody = vm.runInContext('new Uint8Array(8)', context)
    const opened = await bridge.handle(request(14, nodeId, 41, openBody), { processId: 9, source })
    const openedView = new DataView(opened.buffer, opened.byteOffset, opened.byteLength)
    const handleId = openedView.getBigUint64(16, true)
    const releaseBody = vm.runInContext('new Uint8Array(24)', context) as Uint8Array
    new DataView(releaseBody.buffer, releaseBody.byteOffset, releaseBody.byteLength).setBigUint64(0, handleId, true)

    const released = await bridge.handle(request(18, nodeId, 0, releaseBody), { processId: 0, source: null })
    expect(new DataView(released.buffer, released.byteOffset, released.byteLength).getInt32(4, true)).toBe(0)
    expect(context.__holoFuseCalls).toEqual([
      { linuxPid: 41, operation: 'lookup', path: '/workspace/input.txt', processId: 9, source },
      { flags: 0, linuxPid: 41, operation: 'open', path: '/workspace/input.txt', processId: 9, source },
      { handle: 'host-handle', linuxPid: 0, operation: 'release', path: '/workspace/input.txt', processId: 9, source }
    ])
  })
})
