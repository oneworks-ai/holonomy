import { describe, expect, it } from 'vitest'

import { createCapabilityFsModuleOverridesV1 } from '@holonomyjs/capability-fs/kernel/guest-fs-facade'
import type { CapabilityGuestBridgeV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'

const fixture = () => {
  const calls: Record<string, unknown>[] = []
  const result = (request: string) => {
    const call = JSON.parse(request) as Record<string, unknown>
    calls.push(call)
    const value = call.member === 'open'
      ? { binding: { bindingId: 'fd-10', generation: 1 }, resourceType: 'filesystem.file-handle' }
      : {}
    return JSON.stringify({ ok: true, value })
  }
  const bridge: CapabilityGuestBridgeV1 = {
    invoke: async request => result(request),
    invokeSync: request => result(request)
  }
  const modules = createCapabilityFsModuleOverridesV1(bridge)
  return {
    calls,
    fs: modules['node:fs'].commonjsValue as {
      chmodSync(path: unknown, mode: unknown): unknown
      fchmod(fd: unknown, mode: unknown, done: (...args: unknown[]) => void): void
    },
    fsp: modules['node:fs/promises'].commonjsValue as {
      chmod(path: unknown, mode: unknown): Promise<unknown>
      open(path: unknown, flag: unknown): Promise<{ chmod(mode: unknown): Promise<unknown> }>
    }
  }
}

describe('standard chmod facade', () => {
  it('normalizes strict octal modes and returns void with one callback argument', async () => {
    const { calls, fs, fsp } = fixture()
    expect(fs.chmodSync('holo-fs://workspace/file', '0644')).toBeUndefined()
    expect(await fsp.chmod('holo-fs://workspace/file', '755')).toBeUndefined()
    const callback = await new Promise<unknown[]>(resolve => {
      fs.fchmod(10, '0640', (...args) => resolve(args))
    })
    expect(callback).toEqual([null])
    const handle = await fsp.open('holo-fs://workspace/file', 'r')
    expect(await handle.chmod('0600')).toBeUndefined()
    expect(calls.map(call => [call.member, (call.arguments as { mode?: number }).mode])).toEqual([
      ['chmodSync', 0o644],
      ['chmod', 0o755],
      ['fchmod', 0o640],
      ['open', undefined],
      ['FileHandle.chmod', 0o600]
    ])
    expect(calls.at(-1)).toMatchObject({ bindingId: 'fd-10', resourceType: 'filesystem.file-handle' })
  })

  it('rejects special bits, type bits, non-octal text and objects before dispatch', async () => {
    const { calls, fs, fsp } = fixture()
    for (const mode of [0o4755, 0o100644, '0o644', '888', ' 644', {}, new Proxy({}, {})]) {
      expect(() => fs.chmodSync('holo-fs://workspace/file', mode)).toThrow(
        expect.objectContaining({ code: 'EINVAL' })
      )
      await expect(fsp.chmod('holo-fs://workspace/file', mode)).rejects.toMatchObject({ code: 'EINVAL' })
    }
    expect(calls).toHaveLength(0)
  })
})
