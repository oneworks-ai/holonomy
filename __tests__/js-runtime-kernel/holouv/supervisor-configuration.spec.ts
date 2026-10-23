import { describe, expect, it } from 'vitest'

import { encodeProcessSupervisorFrameV1, encodeProcessSupervisorReadyPayloadV1 } from '@holonomyjs/capability-process'
import { HoloUvEnvironmentRuntimeV1, createHoloUvSupervisorEnvironmentFactoryV1 } from '@holonomyjs/holouv'

const ready = encodeProcessSupervisorFrameV1({
  operation: 'ready',
  payload: encodeProcessSupervisorReadyPayloadV1(['process']),
  processId: 0,
  requestId: 0,
  sequence: 0,
  version: 1
})

const request = () => ({
  configuration: { image: 'fixture' },
  executables: [{
    executable: { kind: 'guestPath' as const, path: '/bin/cat' },
    executableId: 'cat',
    fixedArgs: [],
    shell: false
  }],
  generation: 7,
  policy: { access: 'sandboxed' },
  scope: 'processTree' as const
})

const fixture = (readyTimeoutMs: number) => {
  let onConfigure: (() => void) | undefined
  const configured = new Promise<void>(resolve => {
    onConfigure = resolve
  })
  let closes = 0
  const factory = createHoloUvSupervisorEnvironmentFactoryV1({
    createConfiguration: () => Uint8Array.of(2, 0),
    openTransport: ({ onBytes }) => ({
      close: () => {
        closes += 1
      },
      start: () => onBytes(ready),
      write: bytes => {
        if (bytes[9] === 18) onConfigure?.()
      }
    }),
    readyTimeoutMs
  })
  return {
    configured,
    get closes() {
      return closes
    },
    runtime: new HoloUvEnvironmentRuntimeV1(factory)
  }
}

describe('holouv supervisor CONFIGURE admission', () => {
  it('bounds a legacy Guest that never acknowledges private configuration v2', async () => {
    const value = fixture(30)
    const lease = value.runtime.acquire(request(), 'legacy-image')
    const terminal = expect(lease.environment).rejects.toMatchObject({
      code: 'supervisor.configuration_timeout'
    })
    await value.configured
    await terminal
    expect(value.closes).toBe(1)
  })

  it('unblocks generation close while CONFIGURE is awaiting an ACK', async () => {
    const value = fixture(10_000)
    const lease = value.runtime.acquire(request(), 'legacy-image')
    const terminal = expect(lease.environment).rejects.toMatchObject({ code: 'supervisor.cancelled' })
    await value.configured
    await value.runtime.closeGeneration(7)
    await terminal
    expect(value.runtime.activeEnvironmentIds()).toEqual([])
    expect(value.closes).toBe(1)
  })
})
