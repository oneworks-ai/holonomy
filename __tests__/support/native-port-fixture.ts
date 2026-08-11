import { RuntimeEventLoop, createNativeBridge } from '../../src/index.js'

import type {
  HostEventLoopPort,
  HostEventLoopTermination,
  NativeBridgeLimits,
  NativeCallToken,
  NativeDispatchContext,
  NativePort,
  NativePortEvent,
  NativePortEventSink,
  NativePortRequest,
  NativePortResourceEvent,
  NativePortResourceEventSink,
  NativeProviderToken
} from '../../src/index.js'

export class VirtualNativeHost implements HostEventLoopPort {
  readonly terminations: HostEventLoopTermination[] = []
  readonly wakeups: Array<number | null> = []
  checkpointCount = 0
  nowHook?: () => void
  throwOnWakeup = false
  private nowMs = 0

  now() {
    const hook = this.nowHook
    this.nowHook = undefined
    hook?.()
    return this.nowMs
  }

  requestWakeup(deadlineMs: number | null) {
    if (this.throwOnWakeup) throw new Error('host wakeup failure')
    this.wakeups.push(deadlineMs)
  }

  checkpointMicrotasks() {
    this.checkpointCount += 1
  }

  terminate(reason: HostEventLoopTermination) {
    this.terminations.push(reason)
  }

  advanceTo(nowMs: number) {
    this.nowMs = nowMs
  }
}

export interface NativePortCall {
  context: Readonly<NativeDispatchContext>
  request: NativePortRequest
  resourceSink: NativePortResourceEventSink
  sink: NativePortEventSink
}

type ControlledPortAsyncResult = Promise<void> | PromiseLike<void>

export class ControlledNativePort implements NativePort {
  readonly calls: NativePortCall[] = []
  readonly cancellations: Array<{
    callToken: NativeCallToken
    reason?: string
  }> = []
  readonly closedResources: Array<{
    ownerCallToken: NativeCallToken
    providerToken: NativeProviderToken
    reason?: string
  }> = []
  readonly operations: string[] = []
  readonly credits: Array<{ callToken: NativeCallToken; credits: number }> = []
  cancelHook?: (callToken: NativeCallToken, reason?: string) => void
  cancelResult?: Promise<void>
  closeResourceHook?: (
    ownerCallToken: NativeCallToken,
    providerToken: NativeProviderToken,
    reason?: string
  ) => void
  closeResourceResult?: ControlledPortAsyncResult
  dispatchResult?: Promise<void>
  disposeCount = 0
  disposeResult?: Promise<void>
  grantCreditsResult?: Promise<void>
  throwOnDispatch = false

  dispatch(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    resourceSink: NativePortResourceEventSink
  ) {
    this.calls.push({ context, request, resourceSink, sink })
    if (this.throwOnDispatch) throw new Error('secret platform exception')
    return this.dispatchResult
  }

  cancel(callToken: NativeCallToken, reason?: string) {
    this.operations.push(`cancel:${String(reason)}`)
    this.cancellations.push({
      callToken,
      ...(reason === undefined ? {} : { reason })
    })
    this.cancelHook?.(callToken, reason)
    return this.cancelResult
  }

  grantCredits(callToken: NativeCallToken, credits: number) {
    this.credits.push({ callToken, credits })
    return this.grantCreditsResult
  }

  closeResource(
    ownerCallToken: NativeCallToken,
    providerToken: NativeProviderToken,
    reason?: string
  ) {
    this.operations.push(`close:${providerToken}:${String(reason)}`)
    this.closedResources.push({
      ownerCallToken,
      providerToken,
      ...(reason === undefined ? {} : { reason })
    })
    this.closeResourceHook?.(ownerCallToken, providerToken, reason)
    return this.closeResourceResult as Promise<void> | undefined
  }

  dispose() {
    this.disposeCount += 1
    return this.disposeResult
  }

  latest(id: string) {
    const call = this.calls.findLast(item => item.request.id === id)
    if (!call) throw new Error(`Missing call for ${id}`)
    return call
  }

  emit(id: string, event: NativePortEvent) {
    this.latest(id).sink(event)
  }

  revoke(id: string, event: NativePortResourceEvent) {
    this.latest(id).resourceSink(event)
  }
}

export const providerToken = (value: string) => value as NativeProviderToken

export const createDeferred = <T = void>() => {
  let reject!: (reason?: unknown) => void
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise
    resolve = resolvePromise
  })
  return { promise, reject, resolve }
}

export const setupNativeBridge = (
  limits: Partial<NativeBridgeLimits> = {},
  principal = 'guest-1'
) => {
  const host = new VirtualNativeHost()
  const loop = new RuntimeEventLoop(host)
  const port = new ControlledNativePort()
  const bridge = createNativeBridge(port, {
    authority: {
      capabilities: ['runtime.echo', 'runtime.read'],
      principal
    },
    eventLoop: loop,
    limits
  })
  return { bridge, host, loop, port }
}
