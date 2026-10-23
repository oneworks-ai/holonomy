import { describe, expect, it } from 'vitest'
import { RuntimeEngineGateRegistryV1 } from '../../../src/capability-runtime/index.js'
import type { EngineGateDecisionV1, EngineGateMiddlewareV1 } from '../../../src/capability-runtime/index.js'

const metadata = {
  schemaVersion: 1,
  codeKind: 'strings',
  operation: 'runtime.code.generate.strings',
  requestId: 'test-1',
  metadataSupport: { source: 'available', callsite: 'unavailable', entryDetail: 'unavailable', origin: 'unavailable' },
  sourceBytes: 1,
  sourceSha256: 'a'.repeat(64),
  runtime: { generation: 1, policyDigest: 'b'.repeat(64), processId: 'test' }
}
const allow = () => ({ action: 'allow' as const })
const install = (handlers: EngineGateMiddlewareV1[]) => {
  const registry = new RuntimeEngineGateRegistryV1()
  const scope = registry.createPluginScope('plugin')
  handlers.forEach(handler => scope.use(handler))
  registry.preparePluginGraph(1, [scope])()
  return { registry, scope }
}

describe('engine Gate plugin pipeline', () => {
  it('defaults to deny and composes immutable metadata without a Provider', async () => {
    const { registry } = install([])
    expect(await registry.decide(metadata, new AbortController().signal)).toMatchObject({ action: 'deny' })
    const order: string[] = []
    const next = install([async (request, next) => {
      expect(Object.isFrozen(request.runtime)).toBe(true)
      expect(request.origin).toBeUndefined()
      order.push('before')
      const result = await next()
      order.push('after')
      return result
    }, () => {
      order.push('decision')
      return allow()
    }])
    expect(await next.registry.decide(metadata, new AbortController().signal)).toEqual(allow())
    expect(order).toEqual(['before', 'decision', 'after'])
  })

  it('cannot recover a downstream denial, including an unawaited next', async () => {
    const { registry } = install([(_request, next) => {
      void next()
      return allow()
    }, async () => ({ action: 'deny', reasonCode: 'host.denied' })])
    expect(await registry.decide(metadata, new AbortController().signal)).toEqual({
      action: 'deny',
      reasonCode: 'host.denied'
    })
  })

  it('latches duplicate-next failures even if middleware catches the exception', async () => {
    let calls = 0
    const { registry } = install([async (_request, next) => {
      await next()
      try {
        await next()
      } catch {}
      return allow()
    }, () => {
      calls++
      return allow()
    }])
    expect(await registry.decide(metadata, new AbortController().signal)).toEqual({
      action: 'deny',
      reasonCode: 'host.invalid_next'
    })
    expect(calls).toBe(1)
  })

  it('cancels never-settling middleware and blocks late continuation', async () => {
    let next!: () => Promise<EngineGateDecisionV1>
    let downstream = 0
    let reject!: (error: Error) => void
    const { registry } = install([(_request, continuation) => {
      next = continuation
      return new Promise((_resolve, failure) => {
        reject = failure
      })
    }, () => {
      downstream++
      return allow()
    }])
    const controller = new AbortController()
    const pending = registry.decide(metadata, controller.signal)
    await Promise.resolve()
    controller.abort()
    expect(await pending).toMatchObject({ action: 'deny', reasonCode: 'runtime.cancelled' })
    expect(await next()).toMatchObject({ action: 'deny' })
    reject(new Error('late private error'))
    await Promise.resolve()
    expect(downstream).toBe(0)
  })

  it('uses the acquired revision until completion and drains before retirement', async () => {
    let finish!: (value: EngineGateDecisionV1) => void
    const { registry } = install([() =>
      new Promise(resolve => {
        finish = resolve
      })])
    const old = registry.decide(metadata, new AbortController().signal)
    const scope = registry.createPluginScope('plugin')
    scope.use(() => ({ action: 'deny', reasonCode: 'host.new' }))
    registry.preparePluginGraph(2, [scope])()
    let drained = false
    const drain = registry.drainPluginGraph(1).then(() => {
      drained = true
    })
    expect(await registry.decide(metadata, new AbortController().signal)).toMatchObject({ reasonCode: 'host.new' })
    expect(drained).toBe(false)
    finish(allow())
    expect(await old).toEqual(allow())
    await drain
    expect(drained).toBe(true)
  })

  it('rejects foreign/stale publication and closes pending calls', async () => {
    const { registry, scope } = install([() => new Promise(() => {})])
    const other = new RuntimeEngineGateRegistryV1()
    expect(() => registry.preparePluginGraph(2, [other.createPluginScope('foreign')])).toThrow()
    const stale = registry.preparePluginGraph(2, [scope])
    registry.preparePluginGraph(2, [])()
    expect(stale).toThrow()
    registry.preparePluginGraph(3, [scope])()
    const pending = registry.decide(metadata, new AbortController().signal)
    registry.close()
    expect(await pending).toMatchObject({ action: 'deny' })
    expect(() => scope.use(allow)).toThrow()
  })

  it('redacts thrown and malformed decisions', async () => {
    for (
      const handler of [() => {
        throw new Error('PRIVATE')
      }, () => ({ action: 'allow', extra: true })]
    ) {
      const { registry } = install([handler as EngineGateMiddlewareV1])
      expect(await registry.decide(metadata, new AbortController().signal)).toMatchObject({ action: 'deny' })
    }
  })
  it('returns a denial promptly but retains the revision until unawaited downstream settles', async () => {
    let finish!: (value: EngineGateDecisionV1) => void
    let childSignal!: AbortSignal
    const { registry } = install([(_request, next) => {
      void next()
      return { action: 'deny', reasonCode: 'host.outer' }
    }, request => {
      childSignal = request.signal
      return new Promise(resolve => {
        finish = resolve
      })
    }])
    expect(await registry.decide(metadata, new AbortController().signal)).toEqual({
      action: 'deny',
      reasonCode: 'host.outer'
    })
    expect(childSignal.aborted).toBe(true)
    registry.preparePluginGraph(2, [])()
    let drained = false
    const drain = registry.drainPluginGraph(1).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    finish(allow())
    await drain
    expect(drained).toBe(true)
  })
})
