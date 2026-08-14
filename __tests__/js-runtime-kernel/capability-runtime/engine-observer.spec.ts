import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CapabilityContractError,
  OBSERVER_EVENTS_V1,
  STOCK_NODE_ENGINE_PROBE_V1,
  compileRuntimeObserverAdmissionV1,
  compileRuntimeObserverPlatformDescriptorV1,
  normalizeEngineGateDecisionV1,
  normalizeEngineGateRequestMetadataV1,
  normalizeEngineHookCapabilityProbeV1,
  normalizeObserverOverflowPayloadV1,
  normalizeRuntimeObserverEventV1
} from '../../../src/capability-runtime/index.js'

const platform = () => ({
  events: OBSERVER_EVENTS_V1.map(event => ({
    cost: event.startsWith('script.execution') ? 'high' : 'low',
    event,
    optIn: event.startsWith('script.execution'),
    supportLevel: event === 'gc.completed' ? 'unsupported' : 'required'
  })),
  maxObserverCallbackMs: 1000,
  maxQueuedEvents: 64,
  schemaVersion: 1
})

describe('engine hook and runtime observer machine contracts', () => {
  it('records a real stock Node VM capability probe', () => {
    const output = execFileSync(process.execPath, [
      resolve(process.cwd(), 'tools/probe-node-engine-capabilities.mjs')
    ], { encoding: 'utf8' })
    const probe = normalizeEngineHookCapabilityProbeV1(JSON.parse(output))
    expect(probe).toEqual(STOCK_NODE_ENGINE_PROBE_V1)
    expect(probe.strings).toEqual({ generationLevelDeny: true, perCompilationCallback: false })
    expect(probe.wasm).toEqual({ generationLevelDeny: true, perCompilationCallback: false })
  })

  it('rejects fabricated probe metadata and versions', () => {
    expect(() =>
      normalizeEngineHookCapabilityProbeV1({
        ...STOCK_NODE_ENGINE_PROBE_V1,
        metadata: { ...STOCK_NODE_ENGINE_PROBE_V1.metadata, callsite: 'guessed' }
      })
    ).toThrow(CapabilityContractError)
    expect(() =>
      normalizeEngineHookCapabilityProbeV1({
        ...STOCK_NODE_ENGINE_PROBE_V1,
        schemaVersion: 2
      })
    ).toThrow(CapabilityContractError)
  })

  it('keeps Engine Gate metadata honest and decisions product-neutral', () => {
    const request = normalizeEngineGateRequestMetadataV1({
      codeKind: 'strings',
      metadataSupport: {
        callsite: 'unavailable',
        entryDetail: 'unavailable',
        origin: 'unavailable',
        source: 'available'
      },
      operation: 'runtime.code.generate.strings',
      requestId: 'request-1',
      runtime: { generation: 2, policyDigest: 'a'.repeat(64), processId: 'process-1' },
      schemaVersion: 1,
      sourceBytes: 10,
      sourceSha256: 'b'.repeat(64)
    })
    expect(request.sourceBytes).toBe(10)
    expect(normalizeEngineGateDecisionV1({ action: 'allow' })).toEqual({ action: 'allow' })
    expect(() =>
      normalizeEngineGateRequestMetadataV1({
        ...request,
        codeKind: 'wasm'
      })
    ).toThrow(CapabilityContractError)
    expect(() =>
      normalizeEngineGateRequestMetadataV1({
        ...request,
        callsite: { moduleUrl: 'guest.js' }
      })
    ).toThrow(CapabilityContractError)
  })

  it('compiles observer admission as Policy ∩ platform ∩ Host ∩ registration', () => {
    const admitted = compileRuntimeObserverAdmissionV1(
      {
        callbackTimeoutMs: 800,
        events: ['runtime.exception', 'runtime.terminated'],
        maxQueuedEvents: 50
      },
      {
        maxObserverCallbackMs: 500,
        maxQueuedEvents: 40,
        observerEvents: ['runtime.exception', 'runtime.terminated']
      },
      platform(),
      {
        maxObserverCallbackMs: 300,
        maxQueuedEvents: 30
      }
    )
    expect(admitted).toEqual({
      callbackTimeoutMs: 300,
      events: ['runtime.exception', 'runtime.terminated'],
      maxQueuedEvents: 30
    })
  })

  it('requires explicit high-cost opt-in and rejects unsupported events', () => {
    expect(() =>
      compileRuntimeObserverAdmissionV1(
        {
          events: ['script.execution-started']
        },
        {
          maxObserverCallbackMs: 500,
          maxQueuedEvents: 40,
          observerEvents: ['script.execution-started']
        },
        platform(),
        { maxObserverCallbackMs: 500, maxQueuedEvents: 40 }
      )
    )
      .toThrow(CapabilityContractError)
    expect(() =>
      compileRuntimeObserverAdmissionV1(
        {
          acceptHighCost: true,
          events: ['gc.completed']
        },
        {
          maxObserverCallbackMs: 500,
          maxQueuedEvents: 40,
          observerEvents: ['gc.completed']
        },
        platform(),
        { maxObserverCallbackMs: 500, maxQueuedEvents: 40 }
      )
    )
      .toThrow(CapabilityContractError)
  })

  it('locks overflow counts and sequence range', () => {
    expect(normalizeObserverOverflowPayloadV1({
      dropped: 3,
      droppedByEvent: { 'runtime.exception': 2, 'script.compiled': 1 },
      firstDroppedSequence: 4,
      lastDroppedSequence: 9
    })).toEqual({
      dropped: 3,
      droppedByEvent: { 'runtime.exception': 2, 'script.compiled': 1 },
      firstDroppedSequence: 4,
      lastDroppedSequence: 9
    })
    expect(() =>
      normalizeObserverOverflowPayloadV1({
        dropped: 4,
        droppedByEvent: { 'runtime.exception': 2 },
        firstDroppedSequence: 9,
        lastDroppedSequence: 4
      })
    ).toThrow(CapabilityContractError)
  })

  it('normalizes bounded observer envelopes without source leakage', () => {
    expect(normalizeRuntimeObserverEventV1({
      event: 'script.execution-finished',
      generation: 2,
      observedAt: 3.5,
      payload: { executionId: 'exec-1', outcome: 'threw', scriptId: 'script-1' },
      schemaVersion: 1,
      sequence: 4
    })).toMatchObject({ event: 'script.execution-finished', sequence: 4 })
    expect(() =>
      normalizeRuntimeObserverEventV1({
        event: 'script.compiled',
        generation: 2,
        observedAt: 3,
        payload: { scriptId: 'script-1', source: 'secret', sourceBytes: 6, sourceSha256: 'a'.repeat(64) },
        schemaVersion: 1,
        sequence: 4
      })
    ).toThrow(CapabilityContractError)
  })

  it('requires an exhaustive platform descriptor', () => {
    expect(compileRuntimeObserverPlatformDescriptorV1(platform()).events)
      .toHaveLength(OBSERVER_EVENTS_V1.length)
    const missing = platform()
    missing.events.pop()
    expect(() => compileRuntimeObserverPlatformDescriptorV1(missing)).toThrow(CapabilityContractError)
  })
})
