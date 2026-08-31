import { describe, expect, it, vi } from 'vitest'

import { createHoloAuditPluginV1 } from '../../../packages/plugins/audit/src/index.js'
import { createHoloPermissionPluginV1 } from '../../../packages/plugins/permission/src/index.js'
import type { HoloInvocationContextV1, HoloMiddlewareV1 } from '../../../packages/runtime/src/kernel/broker-types.js'
import { snapshot } from '../capability-runtime/broker-fixtures.js'

const invocation = Object.freeze({
  operation: 'filesystem.read',
  resource: Object.freeze({
    requested: Object.freeze({ semanticResourceDigest: 'a'.repeat(64) })
  })
}) as unknown as HoloInvocationContextV1

const install = (plugin: (context: never, config: unknown) => void, config: unknown = {}) => {
  let middleware: HoloMiddlewareV1 | undefined
  let execution: string | undefined
  const deny = vi.fn(() => {
    throw new Error('denied')
  })
  plugin({
    holo: {
      deny,
      intercept: (_matcher: unknown, value: HoloMiddlewareV1, options?: { execution?: string }) => {
        middleware = value
        execution = options?.execution
        return { dispose: vi.fn() }
      }
    }
  } as never, config)
  return { deny, execution, middleware: middleware! }
}

describe('runtime permission and audit plugin foundations', () => {
  it('leaves the product decision in the supplied permission decider', async () => {
    const allow = install(createHoloPermissionPluginV1({ decide: () => 'allow' }) as never, { prompt: 'once' })
    const terminal = snapshot('ok', 'result')
    await expect(allow.middleware(invocation, async () => terminal)).resolves.toBe(terminal)
    expect(allow.deny).not.toHaveBeenCalled()

    const deny = install(createHoloPermissionPluginV1({ decide: () => 'deny' }) as never)
    await expect(deny.middleware(invocation, async () => terminal)).rejects.toThrow('denied')
    expect(deny.deny).toHaveBeenCalledOnce()
  })

  it('observes success and failure without becoming the authorization owner', async () => {
    const sink = vi.fn()
    const audit = install(createHoloAuditPluginV1({ sink }) as never, { retention: 'host-owned' })
    const terminal = snapshot('ok', 'result')
    await expect(audit.middleware(invocation, async () => terminal)).resolves.toBe(terminal)
    expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'succeeded', result: terminal }))

    const failure = new Error('provider failed')
    await expect(audit.middleware(invocation, async () => {
      throw failure
    })).rejects.toBe(failure)
    expect(sink).toHaveBeenLastCalledWith(expect.objectContaining({ error: failure, phase: 'failed' }))
  })

  it('keeps synchronous invocation free of async plugin work', () => {
    const permission = install(createHoloPermissionPluginV1({
      decide: () => 'allow',
      execution: 'sync'
    }) as never)
    const terminal = snapshot('ok', 'result')
    expect(permission.execution).toBe('sync')
    expect(permission.middleware(invocation, () => terminal)).toBe(terminal)
  })
})
