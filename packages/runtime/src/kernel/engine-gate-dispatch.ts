import { normalizeEngineGateDecisionV1 } from './engine-contract.js'
import type { EngineGateDecisionV1, EngineGateRequestMetadataV1 } from './engine-types.js'

export interface EngineGateMiddlewareRequestV1 extends EngineGateRequestMetadataV1 {
  readonly sourceReader?: EngineSourceReaderV1
  readonly signal: AbortSignal
}
export interface EngineSourceReaderV1 {
  read(options: Readonly<{ maxBytes: number }>): Promise<Uint8Array>
}
export type EngineGateMiddlewareV1 = (
  request: EngineGateMiddlewareRequestV1,
  next: () => Promise<EngineGateDecisionV1>
) => EngineGateDecisionV1 | Promise<EngineGateDecisionV1>

export const engineGateDenyV1 = (reasonCode: string): EngineGateDecisionV1 =>
  Object.freeze({ action: 'deny', reasonCode })

/** Host-only composition: no Provider call, source replacement or Guest reentry. */
export const dispatchEngineGateV1 = (
  metadata: EngineGateRequestMetadataV1,
  signal: AbortSignal,
  middleware: readonly EngineGateMiddlewareV1[],
  sourceReader?: EngineSourceReaderV1
): Readonly<{ decision: Promise<EngineGateDecisionV1>; settled: Promise<void> }> => {
  if (signal.aborted) {
    return Object.freeze({
      decision: Promise.resolve(engineGateDenyV1('runtime.cancelled')),
      settled: Promise.resolve()
    })
  }
  const request = Object.freeze({ ...metadata, ...(sourceReader == null ? {} : { sourceReader }), signal })
  let closed = false
  let denial: EngineGateDecisionV1 | undefined
  const active = new Set<Promise<EngineGateDecisionV1>>()
  let settle!: () => void
  const settled = new Promise<void>(resolve => {
    settle = resolve
  })
  const maybeSettled = () => {
    if (closed && active.size === 0) settle()
  }
  const deny = (reason: string) => denial ??= engineGateDenyV1(reason)
  let abort!: () => void
  const cancelled = new Promise<EngineGateDecisionV1>(resolve => {
    abort = () => {
      closed = true
      resolve(deny('runtime.cancelled'))
      maybeSettled()
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  const runFrame = async (index: number): Promise<EngineGateDecisionV1> => {
    if (closed || signal.aborted) return deny('runtime.cancelled')
    const handler = middleware[index]
    if (handler == null) return deny('host.gate_unavailable')
    let called = false
    let frameClosed = false
    let downstream: Promise<EngineGateDecisionV1> | undefined
    try {
      const raw = await handler(request, () => {
        if (closed || frameClosed || signal.aborted) return Promise.resolve(deny('runtime.cancelled'))
        if (called) {
          deny('host.invalid_next')
          throw new Error('next() called multiple times')
        }
        called = true
        downstream = dispatch(index + 1)
        return downstream
      })
      if (closed || signal.aborted) return deny('runtime.cancelled')
      // A middleware may forget to await next(); its downstream denial still
      // participates before any allow can escape the boundary.
      let decision: EngineGateDecisionV1
      try {
        decision = normalizeEngineGateDecisionV1(raw)
      } catch {
        return deny('host.invalid_decision')
      }
      if (decision.action === 'deny') denial ??= decision
      if (denial != null) return denial
      if (downstream != null) await downstream
      if (closed || signal.aborted) return deny('runtime.cancelled')
      return denial ?? decision
    } catch {
      return deny('host.gate_failed')
    } finally {
      frameClosed = true
    }
  }
  const dispatch = (index: number): Promise<EngineGateDecisionV1> => {
    // Register the lease before user code can synchronously abort/reenter.
    const task = Promise.resolve().then(() => runFrame(index))
    active.add(task)
    const release = () => {
      active.delete(task)
      maybeSettled()
    }
    void task.then(release, release)
    return task
  }
  // Decision can settle early; the separate lease observes every started frame,
  // including unawaited next() and handlers that finish after cancellation.
  const decision = Promise.race([dispatch(0), cancelled]).finally(() => {
    closed = true
    signal.removeEventListener('abort', abort)
    maybeSettled()
  })
  return Object.freeze({ decision, settled })
}
