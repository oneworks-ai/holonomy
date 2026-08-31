import { describe, expect, it } from 'vitest'

import { createCapabilityProcessOverrideV1 } from '../../../src/capability-runtime/guest-process-facade.js'

const terminal = (value: unknown) => JSON.stringify({ ok: true, value })

describe('capability node:process override', () => {
  it('keeps mutable Process state on the default export and exposes data-only named exports', () => {
    const binding = createCapabilityProcessOverrideV1({
      context: null,
      process: { arch: 'arm64', argv: [], platform: 'android', versions: { node: '22' } }
    }, {
      invoke: async () => terminal(null),
      invokeSync: request => {
        const member = (JSON.parse(request) as { member: string }).member
        return terminal(
          {
            cwd: 'holo-fs://workspace/',
            env: {},
            execPath: 'holo-fs://runtime/holonomy',
            pid: 42
          }[member as 'cwd' | 'env' | 'execPath' | 'pid']
        )
      }
    })!
    const namespace = binding.namespace as Record<string, unknown>
    const process = namespace.default as { exitCode: number }

    expect(Object.values(Object.getOwnPropertyDescriptors(namespace)).every(descriptor => 'value' in descriptor)).toBe(
      true
    )
    expect(namespace.exitCode).toBe(0)
    process.exitCode = 7
    expect(process.exitCode).toBe(7)
    expect(namespace.exitCode).toBe(0)
    expect(namespace.pid).toBe(42)
  })
})
