import { describe, expect, it } from 'vitest'
import { createInvocationBodyReadersV1 } from '../../../packages/runtime/src/kernel/invocation-host-input.js'
import { CapabilityInvocationError } from '../../../src/capability-runtime/index.js'
import type { HoloInvocationContextV1 } from '../../../src/capability-runtime/index.js'
import { body, create, hostInput, request } from './network-body-reader-fixture.js'

describe('request body reader Host binding', () => {
  it('rejects a stale, malformed or wrong-capability selection', () => {
    const test = create((_context, next) => next())
    const options = {
      admitted: test.admitted,
      engine: 'embedded-v8',
      target: 'desktop' as const,
      requestPrefix: 'test',
      networkProvider: 'host.network.mock' as const,
      networkRequestBodyReader: test.selection
    }
    try {
      expect(() => createInvocationBodyReadersV1({ ...options, admitted: { ...test.admitted, generation: 2 } }))
        .toThrow()
      expect(() =>
        createInvocationBodyReadersV1({
          ...options,
          networkRequestBodyReader: {
            ...test.selection,
            bindings: [{ ...test.selection.bindings[0]!, name: 'host.diagnostics.source.read' }]
          }
        })
      ).toThrow()
      expect(() =>
        createInvocationBodyReadersV1({
          ...options,
          networkRequestBodyReader: {
            ...test.selection,
            bindings: [{
              ...test.selection.bindings[0]!,
              constraints: { maxReadBytes: Number.POSITIVE_INFINITY, maxReads: 1 }
            }]
          }
        })
      ).toThrow()
    } finally {
      test.kernel.close()
    }
  })

  it('expires an unbounded plugin callback using the trusted request deadline', async () => {
    let copy!: Uint8Array
    let binding!: NonNullable<HoloInvocationContextV1['hostBindings']>[number]
    const test = create(
      async context => {
        binding = context.hostBindings![0]!
        copy = await binding.read()
        return new Promise(() => {})
      },
      true,
      undefined,
      5
    )
    try {
      expect(JSON.parse(await test.kernel.invoke(request, undefined, hostInput)).ok).toBe(false)
      expect([...copy]).toEqual(Array.from({ length: body.length }).fill(0))
      await expect(binding.read()).rejects.toThrow('unavailable')
      expect(test.io()).toBe(0)
    } finally {
      test.kernel.close()
    }
  })

  it('is absent without selection and cannot be serialized as body bytes', async () => {
    const test = create((context, next) => {
      expect(context.hostBindings).toBeUndefined()
      expect(JSON.stringify(context)).not.toContain('PRIVATE_REQUEST_BODY')
      return next()
    }, false)
    try {
      expect(JSON.parse(await test.kernel.invoke(request, undefined, hostInput)).ok).toBe(true)
      expect(test.io()).toBe(1)
    } finally {
      test.kernel.close()
    }
  })

  it('binds to the request, gates one read, and revokes after middleware settlement', async () => {
    let context!: HoloInvocationContextV1
    let retained!: Uint8Array
    const test = create(async (value, next) => {
      context = value
      const binding = value.hostBindings![0]!
      expect(binding.requestId).toBe(value.requestId)
      expect(binding.generation).toBe(value.runtime.generation)
      expect(JSON.stringify(value)).not.toContain('PRIVATE_REQUEST_BODY')
      retained = await binding.read({ maxBytes: 64 })
      expect(new TextDecoder().decode(retained)).toBe('PRIVATE_REQUEST_BODY')
      await expect(binding.read({ maxBytes: 64 })).rejects.toThrow('unavailable')
      return next()
    })
    try {
      expect(JSON.parse(await test.kernel.invoke(request, undefined, hostInput)).ok).toBe(true)
      expect([...retained]).toEqual(Array.from({ length: body.length }).fill(0))
      await expect(context.hostBindings![0]!.read({ maxBytes: 64 })).rejects.toThrow('unavailable')
      expect(test.io()).toBe(1)
    } finally {
      test.kernel.close()
    }
  })

  it('rejects a mismatched staged body before middleware or Provider work', async () => {
    let calls = 0
    const test = create((_context, next) => {
      calls++
      return next()
    })
    try {
      const result = JSON.parse(await test.kernel.invoke(request, undefined, { networkRequestBodyBase64: 'eA==' }))
      expect(result.ok).toBe(false)
      expect(calls).toBe(0)
      expect(test.io()).toBe(0)
    } finally {
      test.kernel.close()
    }
  })

  it.each(['deny', 'timeout', 'abort', 'restart'] as const)(
    'revokes and zeroes on %s before Provider I/O',
    async action => {
      let notify!: () => void
      let settle!: () => void
      const ready = new Promise<void>(resolve => {
        notify = resolve
      })
      const waiting = new Promise<void>(resolve => {
        settle = resolve
      })
      let binding!: NonNullable<HoloInvocationContextV1['hostBindings']>[number]
      let copy!: Uint8Array
      const test = create(
        async (context, next) => {
          binding = context.hostBindings![0]!
          copy = await binding.read({ maxBytes: 64 })
          notify()
          if (action === 'deny') throw new CapabilityInvocationError('middleware.permission_denied', context.operation)
          await waiting
          return next()
        },
        true,
        action === 'timeout' ? 5 : undefined
      )
      const controller = new AbortController()
      const pending = test.kernel.invoke(request, controller.signal, hostInput)
      try {
        await ready
        if (action === 'abort') controller.abort()
        if (action === 'restart') test.kernel.close(true)
        expect(JSON.parse(await pending).ok).toBe(false)
        expect([...copy]).toEqual(Array.from({ length: body.length }).fill(0))
        await expect(binding.read({ maxBytes: 64 })).rejects.toThrow('unavailable')
        expect(test.io()).toBe(0)
        settle()
        await waiting
        await Promise.resolve()
        expect(test.io()).toBe(0)
      } finally {
        settle()
        test.kernel.close()
      }
    }
  )
})
