/* eslint-disable max-lines -- admission, loop ordering and resource accounting require one lifecycle owner. */

import { RuntimeEventLoop } from '../event-loop/runtime-event-loop.js'
import { NativeBridgeError, createNativeBridgeError } from './errors.js'
import { extractUndeliveredResourceGrants, preflightNativePortEvent } from './event-validation.js'
import { createNativeResourceHandle, inspectNativeResourceHandle } from './native-resource.js'
import { NativeStreamHandle } from './native-stream.js'
import {
  materializeNativePortRequest,
  prepareNativeCallOptions,
  prepareNativeRequest,
  resolveNativeAuthority,
  resolveNativeBridgeLimits
} from './request-validation.js'
import { copyBinary } from './value-validation.js'

import type { EventLoopTaskId, EventLoopTimerId } from '../event-loop/types.js'
import type { PreparedNativeOutput } from './event-validation.js'
import type { PreparedAbortSignal, PreparedNativeCallOptions, PreparedNativeRequest } from './request-validation.js'
import type {
  NativeAuthority,
  NativeBridge,
  NativeBridgeLimits,
  NativeBridgeOptions,
  NativeBridgeSnapshot,
  NativeCallOptions,
  NativeCallToken,
  NativeChunk,
  NativeDispatchContext,
  NativePort,
  NativePortErrorCode,
  NativePortErrorDetails,
  NativePortErrorDomain,
  NativePortEvent,
  NativePortEventSink,
  NativePortRequest,
  NativePortResourceBinding,
  NativePortResourceEvent,
  NativePortResourceEventSink,
  NativePortResourceReference,
  NativeProviderToken,
  NativeRequest,
  NativeResourceHandle,
  NativeResult,
  NativeStream
} from './types.js'

export { DEFAULT_NATIVE_BRIDGE_LIMITS } from './request-validation.js'

interface NativePortBindings {
  cancel: NativePort['cancel']
  closeResource: NativePort['closeResource']
  dispatch: NativePort['dispatch']
  dispose: NativePort['dispose']
  grantCredits: NativePort['grantCredits']
}

interface EventLoopBindings {
  addLifecycleObserver: RuntimeEventLoop['addLifecycleObserver']
  cancelNativeRequest: RuntimeEventLoop['cancelNativeRequest']
  cancelTask: RuntimeEventLoop['cancelTask']
  clearTimer: RuntimeEventLoop['clearTimer']
  completeNativeRequest: RuntimeEventLoop['completeNativeRequest']
  enqueueMacrotask: RuntimeEventLoop['enqueueMacrotask']
  getCurrentTime: RuntimeEventLoop['getCurrentTime']
  registerNativeRequest: RuntimeEventLoop['registerNativeRequest']
  setTimeout: RuntimeEventLoop['setTimeout']
}

interface StreamReader {
  reject: (error: NativeBridgeError) => void
  resolve: (
    result: IteratorResult<NativeChunk, NativeResult | undefined>
  ) => void
}

interface ResourceRecord {
  handle: NativeResourceHandle
  ownerCallToken: NativeCallToken
  providerToken: NativeProviderToken
  revokeQueued: boolean
  state: 'closed' | 'open'
  type: string
}

interface ResourceReservation {
  grant: PreparedNativeOutput['resources'][number]
  owner: PendingRequest
  released: boolean
  revokeQueued: boolean
}

interface OutputReservation {
  binary: ReturnType<typeof copyBinary>
  binaryBytes: number
  binaryHandles: number
  delivered: boolean
  resources: ResourceReservation[]
  value?: NativeResult['value']
}

interface QueuedChunk {
  output: OutputReservation
  reader: StreamReader
  sequence: number
  taskId?: EventLoopTaskId
}

type QueuedTerminal =
  | {
    code: NativePortErrorCode
    details?: Readonly<NativePortErrorDetails>
    domain?: NativePortErrorDomain
    taskId?: EventLoopTaskId
  }
  | { output: OutputReservation; taskId?: EventLoopTaskId }

interface PendingBase {
  abortListener?: () => void
  callToken: NativeCallToken
  completion?: QueuedTerminal
  credits: number
  deadlineMs?: number
  deadlineTimer?: EventLoopTimerId
  id: string
  inputBinaryBytes: number
  inputBinaryHandles: number
  loopRegistered: boolean
  mode: 'result' | 'stream'
  abortSignal?: PreparedAbortSignal
  providerCancelIssued: boolean
  state: 'active' | 'settled'
  undeliveredCleanup?: UndeliveredCleanup
}

interface UndeliveredCleanup {
  acceptingReentry: boolean
  capped: boolean
  closedTokens: Set<NativeProviderToken>
  processing: boolean
  queue: Array<{ ownerCallToken: NativeCallToken; providerToken: NativeProviderToken }>
}

interface UnaryPending extends PendingBase {
  mode: 'result'
  reject: (error: NativeBridgeError) => void
  resolve: (result: NativeResult) => void
}

type StreamTerminal =
  | { error: NativeBridgeError; kind: 'error' }
  | { kind: 'end'; result: NativeResult }

interface StreamPending extends PendingBase {
  deliveries: Set<QueuedChunk>
  mode: 'stream'
  nextSequence: number
  readers: StreamReader[]
  terminal?: StreamTerminal
}

type PendingRequest = StreamPending | UnaryPending

interface ResolvedResourceUse {
  record: ResourceRecord
  reference: NativePortResourceReference
}

let nextControllerId = 1

const normalizeCancelReason = (reason: string | undefined) =>
  typeof reason === 'string' && reason.length > 0 && reason.length <= 256
    ? reason
    : undefined

const readBridgeOptionsStrict = (options: NativeBridgeOptions) => {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    throw createNativeBridgeError('invalid_request')
  }
  const prototype = Object.getPrototypeOf(options)
  const readDescriptor = (key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(options, key)
    return descriptor != null && descriptor.enumerable && 'value' in descriptor
      ? descriptor
      : undefined
  }
  const authority = readDescriptor('authority')
  const eventLoop = readDescriptor('eventLoop')
  const limits = readDescriptor('limits')
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    authority == null ||
    eventLoop == null ||
    (Object.prototype.hasOwnProperty.call(options, 'limits') && limits == null)
  ) {
    throw createNativeBridgeError('invalid_request')
  }
  if (!(eventLoop.value instanceof RuntimeEventLoop)) {
    throw createNativeBridgeError('invalid_request')
  }
  return {
    authority: resolveNativeAuthority(authority.value),
    eventLoop: eventLoop.value,
    limits: resolveNativeBridgeLimits(limits?.value)
  }
}

const readBridgeOptions = (options: NativeBridgeOptions) => {
  try {
    return readBridgeOptionsStrict(options)
  } catch (error) {
    throw error instanceof NativeBridgeError
      ? error
      : createNativeBridgeError('invalid_request')
  }
}

const bindDataMethod = <TFunction extends (...args: never[]) => unknown>(
  target: object,
  name: string
): TFunction => {
  let current: object | null = target
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw createNativeBridgeError('invalid_request')
      }
      return descriptor.value.bind(target) as TFunction
    }
    current = Object.getPrototypeOf(current)
  }
  throw createNativeBridgeError('invalid_request')
}

const bindNativePort = (port: NativePort): NativePortBindings => {
  if (port == null || (typeof port !== 'object' && typeof port !== 'function')) {
    throw createNativeBridgeError('invalid_request')
  }
  return Object.freeze({
    cancel: bindDataMethod(port, 'cancel') as NativePort['cancel'],
    closeResource: bindDataMethod(port, 'closeResource') as NativePort['closeResource'],
    dispatch: bindDataMethod(port, 'dispatch') as NativePort['dispatch'],
    dispose: bindDataMethod(port, 'dispose') as NativePort['dispose'],
    grantCredits: bindDataMethod(port, 'grantCredits') as NativePort['grantCredits']
  })
}

const bindEventLoop = (loop: RuntimeEventLoop): EventLoopBindings =>
  Object.freeze({
    addLifecycleObserver: RuntimeEventLoop.prototype.addLifecycleObserver.bind(loop),
    cancelNativeRequest: RuntimeEventLoop.prototype.cancelNativeRequest.bind(loop),
    cancelTask: RuntimeEventLoop.prototype.cancelTask.bind(loop),
    clearTimer: RuntimeEventLoop.prototype.clearTimer.bind(loop),
    completeNativeRequest: RuntimeEventLoop.prototype.completeNativeRequest.bind(loop),
    enqueueMacrotask: RuntimeEventLoop.prototype.enqueueMacrotask.bind(loop),
    getCurrentTime: RuntimeEventLoop.prototype.getCurrentTime.bind(loop),
    registerNativeRequest: RuntimeEventLoop.prototype.registerNativeRequest.bind(loop),
    setTimeout: RuntimeEventLoop.prototype.setTimeout.bind(loop)
  })

class NativeBridgeController implements NativeBridge {
  private readonly authority: Readonly<NativeAuthority>
  private readonly controllerId: string
  private readonly detachLoopLifecycle: () => boolean
  private readonly limits: NativeBridgeLimits
  private readonly loop: EventLoopBindings
  private readonly openResourceRecords = new Set<ResourceRecord>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly port: NativePortBindings
  private readonly resourceByHandle = new WeakMap<object, ResourceRecord>()
  private readonly resourceEventTasks = new Set<EventLoopTaskId>()
  private readonly resourceByProviderToken = new Map<
    NativeProviderToken,
    ResourceRecord | ResourceReservation
  >()
  private admissionActive = false
  private admissionViolated = false
  private callGeneration = 0
  private disposed = false
  private inFlightBinaryBytes = 0
  private inFlightBinaryHandles = 0
  private lifecycleGeneration = 0
  private openHandles = 0
  private openResources = 0
  private outstandingCredits = 0
  private terminalCode: 'disposed' | 'internal' = 'disposed'

  constructor(port: NativePort, options: NativeBridgeOptions) {
    const resolved = readBridgeOptions(options)
    this.authority = resolved.authority
    this.controllerId = `native-controller:${nextControllerId++}`
    this.limits = resolved.limits
    this.loop = bindEventLoop(resolved.eventLoop)
    this.port = bindNativePort(port)
    this.detachLoopLifecycle = this.loop.addLifecycleObserver(reason => {
      this.terminateFromLoop(reason.kind)
    })
  }

  get isDisposed() {
    if (this.admissionActive) this.admissionViolated = true
    return this.disposed
  }

  request(
    request: NativeRequest,
    options?: NativeCallOptions
  ): Promise<NativeResult> {
    if (this.disposed) return Promise.reject(createNativeBridgeError('disposed'))
    if (this.admissionActive) {
      this.admissionViolated = true
      return Promise.reject(createNativeBridgeError('invalid_request'))
    }

    return new Promise<NativeResult>((resolve, reject) => {
      try {
        const pending = this.admit(request, options, 'result', { reject, resolve })
        this.dispatch(pending)
      } catch (error) {
        reject(this.normalizeAdmissionError(error))
      }
    })
  }

  stream(
    request: NativeRequest,
    options?: NativeCallOptions
  ): NativeStream {
    if (this.disposed) throw createNativeBridgeError('disposed')
    if (this.admissionActive) {
      this.admissionViolated = true
      throw createNativeBridgeError('invalid_request')
    }

    let pending: StreamPending | undefined
    try {
      pending = this.admit(request, options, 'stream')
      const stream = new NativeStreamHandle(
        pending.id,
        () => this.readStream(pending!),
        reason => this.cancelPending(pending!, reason)
      )
      this.dispatch(pending)
      return stream
    } catch (error) {
      if (pending && this.isCurrent(pending)) {
        this.settleError(pending, createNativeBridgeError('internal'))
      }
      throw this.normalizeAdmissionError(error)
    }
  }

  cancel(id: string, reason?: string): boolean {
    if (this.admissionActive) {
      this.admissionViolated = true
      return false
    }
    const pending = typeof id === 'string' ? this.pending.get(id) : undefined
    return pending ? this.cancelPending(pending, reason) : false
  }

  revokeResource(handle: NativeResourceHandle, reason?: string): boolean {
    if (this.admissionActive) {
      this.admissionViolated = true
      return false
    }
    if (handle == null || typeof handle !== 'object') return false
    const record = this.resourceByHandle.get(handle)
    return record
      ? this.closeResource(record, true, normalizeCancelReason(reason) ?? 'revoke')
      : false
  }

  dispose(): void {
    if (this.admissionActive) this.admissionViolated = true
    this.terminateBridge('disposed', 'dispose', true)
  }

  private terminateFromLoop(kind: 'error' | 'shutdown') {
    this.terminateBridge(
      kind === 'shutdown' ? 'disposed' : 'internal',
      kind === 'shutdown' ? 'loop_shutdown' : 'loop_error',
      false
    )
  }

  private terminateBridge(
    code: 'disposed' | 'internal',
    reason: string,
    detachLoop: boolean
  ) {
    if (this.disposed) return
    this.disposed = true
    this.terminalCode = code
    this.lifecycleGeneration += 1
    if (detachLoop) {
      try {
        this.detachLoopLifecycle()
      } catch {
        // Disposal does not depend on observer bookkeeping.
      }
    }
    for (const pending of [...this.pending.values()]) {
      this.settleError(pending, createNativeBridgeError(code))
      this.cancelPendingProvider(pending, reason)
    }
    for (const resource of [...this.openResourceRecords]) {
      this.closeResource(resource, true, reason)
    }
    for (const taskId of this.resourceEventTasks) this.safeCancelTask(taskId)
    this.resourceEventTasks.clear()
    this.consumePortResult(() => this.port.dispose())
  }

  getSnapshot(): NativeBridgeSnapshot {
    if (this.admissionActive) this.admissionViolated = true
    return {
      inFlightBinaryBytes: this.inFlightBinaryBytes,
      inFlightBinaryHandles: this.inFlightBinaryHandles,
      openHandles: this.openHandles,
      openResources: this.openResources,
      outstandingCredits: this.outstandingCredits,
      pendingRequests: this.pending.size
    }
  }

  private admit(
    request: NativeRequest,
    options: NativeCallOptions | undefined,
    mode: 'stream'
  ): StreamPending
  private admit(
    request: NativeRequest,
    options: NativeCallOptions | undefined,
    mode: 'result',
    promise: Pick<UnaryPending, 'reject' | 'resolve'>
  ): UnaryPending
  private admit(
    request: NativeRequest,
    options: NativeCallOptions | undefined,
    mode: 'result' | 'stream',
    promise?: Pick<UnaryPending, 'reject' | 'resolve'>
  ): PendingRequest {
    this.admissionActive = true
    this.admissionViolated = false
    const lifecycleGeneration = this.lifecycleGeneration
    const callToken = this.allocateCallToken()
    const callGeneration = this.callGeneration
    const resourceUses: ResolvedResourceUse[] = []
    const resourceReferences = new Map<ResourceRecord, NativePortResourceReference>()
    let callOptions: PreparedNativeCallOptions | undefined
    let prepared: PreparedNativeRequest | undefined
    let pending: PendingRequest | undefined
    let loopRegistered = false
    let deadlineTimer: EventLoopTimerId | undefined
    let abortListener: (() => void) | undefined
    let signalAttached = false
    let committed = false
    let failed = false
    let failure: unknown
    let violated = false

    try {
      callOptions = prepareNativeCallOptions(options)
      prepared = prepareNativeRequest(
        request,
        callOptions,
        this.limits,
        () => this.readLoopTime(),
        value =>
          this.resolveResourceReference(
            value,
            resourceUses,
            resourceReferences
          )
      )
      this.assertAdmissible(
        prepared,
        mode,
        resourceUses,
        lifecycleGeneration,
        callGeneration
      )
      const portRequest = materializeNativePortRequest(prepared)
      pending = mode === 'result'
        ? {
          callToken,
          credits: 0,
          id: prepared.id,
          inputBinaryBytes: prepared.binaryPlan.bytes,
          inputBinaryHandles: prepared.binaryPlan.handles,
          loopRegistered: false,
          mode,
          providerCancelIssued: false,
          reject: promise!.reject,
          resolve: promise!.resolve,
          state: 'active'
        }
        : {
          callToken,
          credits: 0,
          deliveries: new Set(),
          id: prepared.id,
          inputBinaryBytes: prepared.binaryPlan.bytes,
          inputBinaryHandles: prepared.binaryPlan.handles,
          loopRegistered: false,
          mode,
          nextSequence: 0,
          providerCancelIssued: false,
          readers: [],
          state: 'active'
        }
      Object.defineProperty(pending, 'portRequest', {
        configurable: true,
        value: portRequest
      })
      Object.defineProperty(pending, 'resourceBindings', {
        configurable: true,
        value: this.createResourceBindings(resourceUses)
      })

      this.loop.registerNativeRequest(callToken, { ref: true })
      loopRegistered = true
      if (prepared.deadlineMs !== undefined) {
        deadlineTimer = this.armDeadline(pending, prepared.deadlineMs)
      }
      if (callOptions.abortSignal) {
        abortListener = () => this.cancelPending(pending!, 'abort')
        callOptions.abortSignal.add(abortListener)
        signalAttached = true
        if (callOptions.abortSignal.readAborted()) {
          throw createNativeBridgeError('cancelled')
        }
      }

      this.assertAdmissible(
        prepared,
        mode,
        resourceUses,
        lifecycleGeneration,
        callGeneration
      )
      pending.loopRegistered = true
      pending.deadlineMs = prepared.deadlineMs
      pending.deadlineTimer = deadlineTimer
      pending.abortListener = abortListener
      pending.abortSignal = callOptions.abortSignal
      this.pending.set(pending.id, pending)
      this.inFlightBinaryBytes += pending.inputBinaryBytes
      this.inFlightBinaryHandles += pending.inputBinaryHandles
      this.openHandles += pending.inputBinaryHandles + (mode === 'stream' ? 1 : 0)
      committed = true
    } catch (error) {
      failed = true
      failure = error
    } finally {
      this.admissionActive = false
      violated = this.admissionViolated
      this.admissionViolated = false
      if (!committed) {
        if (signalAttached && callOptions?.abortSignal && abortListener) {
          try {
            callOptions.abortSignal.remove(abortListener)
          } catch {
            // A hostile signal cannot prevent rollback.
          }
        }
        if (deadlineTimer !== undefined) this.safeClearTimer(deadlineTimer)
        if (loopRegistered) this.safeCancelNativeRequest(callToken)
      }
    }
    if (violated && committed && pending && this.isCurrent(pending)) {
      this.settleError(pending, createNativeBridgeError('invalid_request'))
      this.cancelPendingProvider(pending, 'invalid_request')
    }
    if (violated) {
      throw createNativeBridgeError(this.disposed ? 'disposed' : 'invalid_request')
    }
    if (failed) throw failure
    if (!pending) throw createNativeBridgeError('internal')
    return pending
  }

  private dispatch(pending: PendingRequest) {
    if (!this.isCurrent(pending) || this.disposed) return
    const request = (pending as PendingRequest & {
      portRequest: NativePortRequest
    }).portRequest
    const resources = (pending as PendingRequest & {
      resourceBindings: readonly NativePortResourceBinding[]
    }).resourceBindings
    const context: Readonly<NativeDispatchContext> = Object.freeze({
      authority: this.authority,
      callToken: pending.callToken,
      mode: pending.mode,
      resources
    })
    const sink: NativePortEventSink = event => this.handleProviderEvent(pending, event)
    const resourceSink: NativePortResourceEventSink = event => {
      this.handleProviderResourceEvent(pending.callToken, pending, event)
    }
    this.consumePortResult(
      () => this.port.dispatch(request, context, sink, resourceSink),
      () => this.failProvider(pending, 'internal')
    )
  }

  private assertAdmissible(
    prepared: PreparedNativeRequest,
    mode: PendingRequest['mode'],
    resources: readonly ResolvedResourceUse[],
    lifecycleGeneration: number,
    callGeneration: number
  ) {
    if (
      this.admissionViolated ||
      this.disposed ||
      this.lifecycleGeneration !== lifecycleGeneration ||
      this.callGeneration !== callGeneration
    ) {
      throw createNativeBridgeError(this.disposed ? 'disposed' : 'invalid_request')
    }
    if (this.pending.has(prepared.id)) {
      throw createNativeBridgeError('invalid_request')
    }
    if (this.pending.size >= this.limits.maxPendingRequests) {
      throw createNativeBridgeError('limit_exceeded')
    }
    if (
      this.inFlightBinaryBytes + prepared.binaryPlan.bytes >
        this.limits.maxInFlightBinaryBytes ||
      this.inFlightBinaryHandles + prepared.binaryPlan.handles >
        this.limits.maxInFlightBinaryHandles ||
      this.openHandles + prepared.binaryPlan.handles + (mode === 'stream' ? 1 : 0) >
        this.limits.maxHandles
    ) {
      throw createNativeBridgeError('limit_exceeded')
    }
    for (const use of resources) {
      if (
        use.record.state !== 'open' ||
        !this.openResourceRecords.has(use.record) ||
        this.resourceByHandle.get(use.record.handle) !== use.record
      ) {
        throw createNativeBridgeError('resource_invalid')
      }
    }
  }

  private resolveResourceReference(
    value: object,
    uses: ResolvedResourceUse[],
    references: Map<ResourceRecord, NativePortResourceReference>
  ) {
    const metadata = inspectNativeResourceHandle(value)
    if (!metadata) return undefined
    if (
      metadata.controllerId !== this.controllerId ||
      metadata.principal !== this.authority.principal ||
      !metadata.isOpen()
    ) {
      throw createNativeBridgeError('resource_invalid')
    }
    const record = this.resourceByHandle.get(value)
    if (!record || record.state !== 'open') {
      throw createNativeBridgeError('resource_invalid')
    }
    let reference = references.get(record)
    if (reference === undefined) {
      reference = Object.freeze({ resource: `resource:${references.size}` })
      references.set(record, reference)
      uses.push({ record, reference })
    }
    return reference
  }

  private createResourceBindings(
    uses: readonly ResolvedResourceUse[]
  ): readonly NativePortResourceBinding[] {
    return Object.freeze(uses.map(use =>
      Object.freeze({
        ownerCallToken: use.record.ownerCallToken,
        providerToken: use.record.providerToken,
        reference: use.reference,
        type: use.record.type
      })
    ))
  }

  private allocateCallToken(): NativeCallToken {
    this.callGeneration += 1
    return `${this.controllerId}:call:${this.callGeneration}` as NativeCallToken
  }

  private armDeadline(
    pending: PendingRequest,
    deadlineMs: number
  ): EventLoopTimerId {
    const now = this.readLoopTime()
    if (now >= deadlineMs) throw createNativeBridgeError('timeout')
    return this.loop.setTimeout(
      () => this.handleDeadline(pending, deadlineMs),
      Math.max(0, deadlineMs - now),
      { ref: true }
    )
  }

  private handleDeadline(pending: PendingRequest, deadlineMs: number) {
    if (!this.isCurrent(pending)) return
    pending.deadlineTimer = undefined
    let now: number
    try {
      now = this.readLoopTime()
    } catch {
      this.settleError(pending, createNativeBridgeError('internal'))
      this.cancelPendingProvider(pending, 'internal')
      return
    }
    if (now < deadlineMs) {
      try {
        pending.deadlineTimer = this.armDeadline(pending, deadlineMs)
      } catch {
        this.settleError(pending, createNativeBridgeError('internal'))
        this.cancelPendingProvider(pending, 'internal')
      }
      return
    }
    this.settleError(pending, createNativeBridgeError('timeout'))
    this.cancelPendingProvider(pending, 'timeout')
  }

  private handleProviderEvent(pending: PendingRequest, event: NativePortEvent) {
    if (!this.isCurrent(pending)) return
    if (pending.completion && !pending.undeliveredCleanup?.acceptingReentry) {
      return
    }
    const extractedGrants = extractUndeliveredResourceGrants(event, this.limits)
    if (!this.isCurrent(pending) || pending.completion) {
      this.closeUndeliveredGrants(pending, extractedGrants.grants)
      return
    }
    const extractionFailure = this.getUndeliveredGrantFailure(extractedGrants)
    if (extractionFailure) {
      this.failProviderWithUndelivered(
        pending,
        extractionFailure,
        extractedGrants.grants
      )
      return
    }
    const acceptChunk = pending.mode === 'stream' &&
      pending.credits > 0 && pending.readers.length > 0
    const preflight = preflightNativePortEvent(
      event,
      pending.id,
      this.limits,
      acceptChunk
    )
    if (!this.isCurrent(pending) || pending.completion) {
      this.closeUndeliveredGrants(pending, extractedGrants.grants)
      return
    }
    if (!preflight.ok) {
      this.failProviderWithUndelivered(
        pending,
        preflight.code,
        extractedGrants.grants
      )
      return
    }
    const providerEvent = preflight.event
    if (providerEvent.type === 'error') {
      this.queueTerminal(pending, { ...providerEvent.error })
      return
    }
    if (providerEvent.type === 'result') {
      if (pending.mode !== 'result') {
        this.failProviderWithUndelivered(
          pending,
          'protocol_error',
          providerEvent.output.resources
        )
        return
      }
      const output = this.reserveOutput(pending, providerEvent.output)
      if (!output) return
      this.queueTerminal(pending, { output })
      return
    }
    if (providerEvent.type === 'end') {
      if (pending.mode !== 'stream') {
        this.failProviderWithUndelivered(
          pending,
          'protocol_error',
          providerEvent.output.resources
        )
        return
      }
      const output = this.reserveOutput(pending, providerEvent.output)
      if (!output) return
      this.queueTerminal(pending, { output })
      return
    }
    if (
      pending.mode !== 'stream' ||
      providerEvent.sequence !== pending.nextSequence ||
      pending.credits <= 0
    ) {
      this.failProviderWithUndelivered(
        pending,
        'protocol_error',
        providerEvent.output.resources
      )
      return
    }
    const output = this.reserveOutput(pending, providerEvent.output)
    if (!output) return
    const reader = pending.readers.shift()
    if (!reader) {
      const completion = this.lockProviderFailure(pending, 'protocol_error')
      this.releaseOutput(output, true)
      if (completion) {
        this.cancelPendingProvider(pending, 'protocol_error')
        this.scheduleTerminal(pending, completion)
      }
      return
    }
    pending.credits -= 1
    this.outstandingCredits -= 1
    pending.nextSequence += 1
    const delivery: QueuedChunk = {
      output,
      reader,
      sequence: providerEvent.sequence
    }
    pending.deliveries.add(delivery)
    try {
      const taskId = this.loop.enqueueMacrotask(
        () => this.deliverChunk(pending, delivery),
        { ref: true }
      )
      delivery.taskId = taskId
      if (!this.isCurrent(pending) || !pending.deliveries.has(delivery)) {
        this.safeCancelTask(taskId)
      }
    } catch {
      this.failLoopScheduling(pending)
    }
  }

  private reserveOutput(
    pending: PendingRequest,
    output: PreparedNativeOutput
  ): OutputReservation | undefined {
    const binaryBytes = output.binaryPlan.bytes
    const binaryHandles = output.binaryPlan.handles
    const resourceCount = output.resources.length
    const seenTokens = new Set<NativeProviderToken>()
    if (
      output.resources.some(resource =>
        seenTokens.has(resource.providerToken) ||
        (seenTokens.add(resource.providerToken), false) ||
        this.resourceByProviderToken.has(resource.providerToken)
      )
    ) {
      this.failProviderWithUndelivered(
        pending,
        'protocol_error',
        output.resources
      )
      return undefined
    }
    if (
      this.inFlightBinaryBytes + binaryBytes > this.limits.maxInFlightBinaryBytes ||
      this.inFlightBinaryHandles + binaryHandles >
        this.limits.maxInFlightBinaryHandles ||
      this.openResources + resourceCount > this.limits.maxOpenResources ||
      this.openHandles + binaryHandles + resourceCount > this.limits.maxHandles
    ) {
      this.failProviderWithUndelivered(
        pending,
        'limit_exceeded',
        output.resources
      )
      return undefined
    }

    const reservation: OutputReservation = {
      binary: undefined,
      binaryBytes,
      binaryHandles,
      delivered: false,
      resources: [],
      ...(output.value === undefined ? {} : { value: output.value })
    }
    this.inFlightBinaryBytes += binaryBytes
    this.inFlightBinaryHandles += binaryHandles
    this.openHandles += binaryHandles + resourceCount
    this.openResources += resourceCount
    for (const grant of output.resources) {
      const resource: ResourceReservation = {
        grant,
        owner: pending,
        released: false,
        revokeQueued: false
      }
      reservation.resources.push(resource)
      this.resourceByProviderToken.set(grant.providerToken, resource)
    }
    try {
      reservation.binary = copyBinary(output.binaryPlan)
      return reservation
    } catch {
      const completion = this.lockProviderFailure(pending, 'internal')
      this.releaseOutput(reservation, true)
      if (completion) {
        this.cancelPendingProvider(pending, 'internal')
        this.scheduleTerminal(pending, completion)
      }
      return undefined
    }
  }

  private getUndeliveredGrantFailure(
    extraction: ReturnType<typeof extractUndeliveredResourceGrants>
  ): 'limit_exceeded' | 'protocol_error' | undefined {
    if (extraction.hasDuplicate) return 'protocol_error'
    if (extraction.grants.some(grant => this.resourceByProviderToken.has(grant.providerToken))) {
      return 'protocol_error'
    }
    return extraction.code
  }

  private failProviderWithUndelivered(
    pending: PendingRequest,
    code: 'internal' | 'limit_exceeded' | 'protocol_error',
    grants: PreparedNativeOutput['resources']
  ) {
    const completion = this.lockProviderFailure(pending, code)
    if (!completion) return
    const cleanup = this.prepareUndeliveredCleanup(pending)
    cleanup.acceptingReentry = true
    try {
      this.closeUndeliveredGrants(pending, grants)
      this.cancelPendingProvider(pending, code)
    } finally {
      cleanup.acceptingReentry = false
    }
    this.scheduleTerminal(pending, completion)
  }

  private prepareUndeliveredCleanup(pending: PendingRequest) {
    const cleanup = pending.undeliveredCleanup ?? {
      acceptingReentry: false,
      capped: false,
      closedTokens: new Set<NativeProviderToken>(),
      processing: false,
      queue: []
    }
    pending.undeliveredCleanup = cleanup
    return cleanup
  }

  private closeUndeliveredGrants(
    pending: PendingRequest,
    grants: PreparedNativeOutput['resources']
  ) {
    const cleanup = this.prepareUndeliveredCleanup(pending)
    for (const grant of grants) {
      const existing = this.resourceByProviderToken.get(grant.providerToken)
      const ownerCallToken = this.invalidateCollidingResource(
        existing,
        grant.providerToken,
        pending.callToken
      )
      if (ownerCallToken !== undefined) {
        this.enqueueUndeliveredClose(
          pending,
          cleanup,
          ownerCallToken,
          grant.providerToken
        )
      }
    }
    this.drainUndeliveredCleanup(pending, cleanup)
  }

  private invalidateCollidingResource(
    resource: ResourceRecord | ResourceReservation | undefined,
    providerToken: NativeProviderToken,
    fallbackOwner: NativeCallToken
  ) {
    if (!resource) return fallbackOwner
    if ('state' in resource) {
      if (resource.ownerCallToken !== fallbackOwner) return undefined
      if (resource.state === 'open') {
        resource.state = 'closed'
        this.openResourceRecords.delete(resource)
        this.openHandles -= 1
        this.openResources -= 1
      }
      if (this.resourceByProviderToken.get(providerToken) === resource) {
        this.resourceByProviderToken.delete(providerToken)
      }
      return resource.ownerCallToken
    }
    if (resource.owner.callToken !== fallbackOwner) return undefined
    if (!resource.released) {
      resource.released = true
      this.openHandles -= 1
      this.openResources -= 1
    }
    if (this.resourceByProviderToken.get(providerToken) === resource) {
      this.resourceByProviderToken.delete(providerToken)
    }
    return resource.owner.callToken
  }

  private enqueueUndeliveredClose(
    pending: PendingRequest,
    cleanup: UndeliveredCleanup,
    ownerCallToken: NativeCallToken,
    providerToken: NativeProviderToken
  ) {
    if (cleanup.closedTokens.has(providerToken) || cleanup.capped) return
    const hardCap = Math.min(this.limits.maxHandles, this.limits.maxOpenResources)
    if (cleanup.closedTokens.size >= hardCap) {
      cleanup.capped = true
      return
    }
    cleanup.closedTokens.add(providerToken)
    cleanup.queue.push({ ownerCallToken, providerToken })
  }

  private drainUndeliveredCleanup(
    pending: PendingRequest,
    cleanup: UndeliveredCleanup
  ) {
    if (cleanup.processing) return
    cleanup.processing = true
    try {
      while (cleanup.queue.length > 0) {
        const item = cleanup.queue.shift()
        if (!item) continue
        this.closeProviderResource(
          item.ownerCallToken,
          item.providerToken,
          'undelivered'
        )
      }
    } finally {
      cleanup.processing = false
    }
  }

  private queueTerminal(pending: PendingRequest, completion: QueuedTerminal) {
    if (!this.lockTerminal(pending, completion)) return
    this.scheduleTerminal(pending, completion)
  }

  private lockProviderFailure(
    pending: PendingRequest,
    code: 'internal' | 'limit_exceeded' | 'protocol_error'
  ): QueuedTerminal | undefined {
    const completion: QueuedTerminal = { code }
    return this.lockTerminal(pending, completion) ? completion : undefined
  }

  private lockTerminal(
    pending: PendingRequest,
    completion: QueuedTerminal
  ) {
    if (!this.isCurrent(pending) || pending.completion) {
      if ('output' in completion) this.releaseOutput(completion.output, true)
      return false
    }
    pending.completion = completion
    this.releaseCredits(pending)
    return true
  }

  private scheduleTerminal(
    pending: PendingRequest,
    completion: QueuedTerminal
  ) {
    if (!this.isCurrent(pending) || pending.completion !== completion) return
    try {
      if (pending.mode === 'result') {
        const taskId = this.loop.completeNativeRequest(
          pending.callToken,
          () => this.deliverTerminal(pending, completion),
          { ref: true }
        )
        pending.loopRegistered = false
        completion.taskId = taskId
      } else {
        this.safeCancelNativeRequest(pending.callToken)
        pending.loopRegistered = false
        const taskId = this.loop.enqueueMacrotask(
          () => this.deliverTerminal(pending, completion),
          { ref: true }
        )
        completion.taskId = taskId
      }
      if (!this.isCurrent(pending) || pending.completion !== completion) {
        if (completion.taskId !== undefined) this.safeCancelTask(completion.taskId)
      }
    } catch {
      this.failLoopScheduling(pending)
    }
  }

  private deliverTerminal(
    pending: PendingRequest,
    completion: QueuedTerminal
  ) {
    if (!this.isCurrent(pending) || pending.completion !== completion) return
    pending.completion = undefined
    if ('code' in completion) {
      this.settleError(
        pending,
        createNativeBridgeError(
          completion.code,
          completion.domain,
          completion.details
        )
      )
      return
    }
    let result: NativeResult
    try {
      result = this.deliverOutput(completion.output)
    } catch {
      this.settleError(pending, createNativeBridgeError('protocol_error'))
      this.cancelPendingProvider(pending, 'protocol_error')
      return
    }
    if (pending.mode === 'result') {
      this.settleUnaryResult(pending, result)
    } else {
      this.settleStreamEnd(pending, result)
    }
  }

  private deliverChunk(pending: StreamPending, delivery: QueuedChunk) {
    if (!this.isCurrent(pending) || !pending.deliveries.delete(delivery)) return
    let result: NativeResult
    try {
      result = this.deliverOutput(delivery.output)
    } catch {
      delivery.reader.reject(createNativeBridgeError('protocol_error'))
      this.failProvider(pending, 'protocol_error')
      return
    }
    delivery.reader.resolve({
      done: false,
      value: Object.freeze({ ...result, sequence: delivery.sequence })
    })
  }

  private deliverOutput(output: OutputReservation): NativeResult {
    if (output.delivered) {
      throw createNativeBridgeError('protocol_error')
    }
    if (output.resources.some(resource => resource.released)) {
      this.releaseOutput(output, true)
      throw createNativeBridgeError('protocol_error')
    }
    output.delivered = true
    this.inFlightBinaryBytes -= output.binaryBytes
    this.inFlightBinaryHandles -= output.binaryHandles
    this.openHandles -= output.binaryHandles
    const resources = output.resources.map(reservation => {
      const grant = reservation.grant
      let record: ResourceRecord
      const handle = createNativeResourceHandle(
        grant.type,
        {
          controllerId: this.controllerId,
          isOpen: () => record.state === 'open',
          principal: this.authority.principal
        },
        reason =>
          this.closeResource(
            record,
            true,
            normalizeCancelReason(reason) ?? 'close'
          )
      )
      record = {
        handle,
        ownerCallToken: reservation.owner.callToken,
        providerToken: grant.providerToken,
        revokeQueued: reservation.revokeQueued,
        state: 'open',
        type: grant.type
      }
      reservation.released = true
      this.resourceByProviderToken.set(grant.providerToken, record)
      this.resourceByHandle.set(handle, record)
      this.openResourceRecords.add(record)
      return handle
    })
    return Object.freeze({
      ...(output.binary === undefined ? {} : { binary: output.binary }),
      ...(resources.length === 0 ? {} : { resources: Object.freeze(resources) }),
      ...(output.value === undefined ? {} : { value: output.value })
    })
  }

  private releaseOutput(output: OutputReservation, closeResources: boolean) {
    if (output.delivered) return
    output.delivered = true
    this.inFlightBinaryBytes -= output.binaryBytes
    this.inFlightBinaryHandles -= output.binaryHandles
    this.openHandles -= output.binaryHandles
    for (const reservation of output.resources) {
      if (reservation.released) continue
      reservation.released = true
      if (this.resourceByProviderToken.get(reservation.grant.providerToken) === reservation) {
        this.resourceByProviderToken.delete(reservation.grant.providerToken)
      }
      this.openHandles -= 1
      this.openResources -= 1
      if (closeResources && !reservation.revokeQueued) {
        this.closeUndeliveredGrants(reservation.owner, [reservation.grant])
      }
    }
  }

  private readStream(
    pending: StreamPending
  ): Promise<IteratorResult<NativeChunk, NativeResult | undefined>> {
    if (pending.terminal?.kind === 'error') {
      return Promise.reject(pending.terminal.error)
    }
    if (pending.terminal?.kind === 'end') {
      return Promise.resolve({ done: true, value: pending.terminal.result })
    }
    if (!this.isCurrent(pending)) {
      return Promise.reject(createNativeBridgeError('cancelled'))
    }
    if (pending.completion) {
      return new Promise((resolve, reject) => {
        pending.readers.push({ reject, resolve })
      })
    }
    if (
      pending.credits >= this.limits.maxCreditsPerStream ||
      this.outstandingCredits >= this.limits.maxOutstandingCredits
    ) {
      return Promise.reject(createNativeBridgeError('limit_exceeded'))
    }

    return new Promise((resolve, reject) => {
      const reader = { reject, resolve }
      pending.readers.push(reader)
      pending.credits += 1
      this.outstandingCredits += 1
      this.consumePortResult(
        () => this.port.grantCredits(pending.callToken, 1),
        () => this.failProvider(pending, 'internal')
      )
    })
  }

  private cancelPending(pending: PendingRequest, reason?: string): boolean {
    if (!this.isCurrent(pending)) return false
    this.settleError(pending, createNativeBridgeError('cancelled'))
    this.cancelPendingProvider(pending, normalizeCancelReason(reason))
    return true
  }

  private settleUnaryResult(pending: UnaryPending, result: NativeResult) {
    if (!this.releasePending(pending)) return
    pending.resolve(result)
  }

  private settleStreamEnd(pending: StreamPending, result: NativeResult) {
    if (!this.releasePending(pending)) return
    pending.terminal = { kind: 'end', result }
    for (const reader of pending.readers.splice(0)) {
      reader.resolve({ done: true, value: result })
    }
  }

  private settleError(pending: PendingRequest, error: NativeBridgeError) {
    if (!this.releasePending(pending, error)) return
    if (pending.mode === 'result') {
      pending.reject(error)
      return
    }
    pending.terminal = { error, kind: 'error' }
    for (const reader of pending.readers.splice(0)) reader.reject(error)
  }

  private releasePending(pending: PendingRequest, error?: NativeBridgeError) {
    if (!this.isCurrent(pending)) return false
    pending.state = 'settled'
    this.pending.delete(pending.id)
    this.clearDeadlineAndSignal(pending)
    if (pending.loopRegistered) {
      this.safeCancelNativeRequest(pending.callToken)
      pending.loopRegistered = false
    }
    if (pending.completion) {
      if (pending.completion.taskId !== undefined) {
        this.safeCancelTask(pending.completion.taskId)
      }
      if ('output' in pending.completion) {
        this.releaseOutput(pending.completion.output, true)
      }
      pending.completion = undefined
    }
    if (pending.mode === 'stream') {
      for (const delivery of pending.deliveries) {
        if (delivery.taskId !== undefined) this.safeCancelTask(delivery.taskId)
        this.releaseOutput(delivery.output, true)
        if (error) delivery.reader.reject(error)
      }
      pending.deliveries.clear()
    }
    this.inFlightBinaryBytes -= pending.inputBinaryBytes
    this.inFlightBinaryHandles -= pending.inputBinaryHandles
    this.openHandles -= pending.inputBinaryHandles +
      (pending.mode === 'stream' ? 1 : 0)
    this.releaseCredits(pending)
    return true
  }

  private clearDeadlineAndSignal(pending: PendingRequest) {
    if (pending.deadlineTimer !== undefined) {
      this.safeClearTimer(pending.deadlineTimer)
      pending.deadlineTimer = undefined
    }
    if (pending.abortSignal && pending.abortListener) {
      try {
        pending.abortSignal.remove(pending.abortListener)
      } catch {
        // Listener cleanup cannot change the selected terminal.
      }
      pending.abortListener = undefined
      pending.abortSignal = undefined
    }
  }

  private releaseCredits(pending: PendingRequest) {
    this.outstandingCredits -= pending.credits
    pending.credits = 0
  }

  private failProvider(
    pending: PendingRequest,
    code: 'internal' | 'limit_exceeded' | 'protocol_error'
  ) {
    const completion = this.lockProviderFailure(pending, code)
    if (!completion) return
    this.cancelPendingProvider(pending, code)
    this.scheduleTerminal(pending, completion)
  }

  private failLoopScheduling(pending: PendingRequest) {
    if (!this.isCurrent(pending)) return
    this.settleError(pending, createNativeBridgeError('internal'))
    this.cancelPendingProvider(pending, 'internal')
  }

  private handleProviderResourceEvent(
    ownerCallToken: NativeCallToken,
    pending: PendingRequest,
    event: NativePortResourceEvent
  ) {
    let providerToken: NativeProviderToken
    try {
      if (event == null || typeof event !== 'object' || Array.isArray(event)) {
        throw createNativeBridgeError('protocol_error')
      }
      const prototype = Object.getPrototypeOf(event)
      const tokenDescriptor = Object.getOwnPropertyDescriptor(event, 'providerToken')
      const typeDescriptor = Object.getOwnPropertyDescriptor(event, 'type')
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        tokenDescriptor == null ||
        !tokenDescriptor.enumerable ||
        !('value' in tokenDescriptor) ||
        typeDescriptor == null ||
        !typeDescriptor.enumerable ||
        !('value' in typeDescriptor) ||
        typeDescriptor.value !== 'revoke'
      ) {
        throw createNativeBridgeError('protocol_error')
      }
      if (
        typeof tokenDescriptor.value !== 'string' ||
        !/^[\w@][\w@./:-]{0,127}$/u.test(tokenDescriptor.value)
      ) {
        throw createNativeBridgeError('protocol_error')
      }
      providerToken = tokenDescriptor.value as NativeProviderToken
    } catch {
      this.failProvider(pending, 'protocol_error')
      return
    }
    const resource = this.resourceByProviderToken.get(providerToken)
    if (!resource) return
    if ('state' in resource) {
      if (resource.ownerCallToken !== ownerCallToken || resource.revokeQueued) return
      resource.revokeQueued = true
    } else {
      if (
        resource.owner.callToken !== ownerCallToken ||
        resource.released ||
        resource.revokeQueued
      ) return
      resource.revokeQueued = true
    }
    try {
      const taskId = this.loop.enqueueMacrotask(() => {
        this.resourceEventTasks.delete(taskId)
        this.applyProviderResourceRevoke(ownerCallToken, providerToken)
      }, { ref: true })
      this.resourceEventTasks.add(taskId)
    } catch {
      if (this.isCurrent(pending)) {
        this.failLoopScheduling(pending)
      } else if ('state' in resource) {
        this.closeResource(resource, false, 'provider_revoke')
      }
    }
  }

  private applyProviderResourceRevoke(
    ownerCallToken: NativeCallToken,
    providerToken: NativeProviderToken
  ) {
    const resource = this.resourceByProviderToken.get(providerToken)
    if (!resource) return
    if ('state' in resource) {
      if (resource.ownerCallToken === ownerCallToken) {
        this.closeResource(resource, false, 'provider_revoke')
      }
      return
    }
    if (resource.owner.callToken === ownerCallToken && !resource.released) {
      resource.released = true
      if (this.resourceByProviderToken.get(providerToken) === resource) {
        this.resourceByProviderToken.delete(providerToken)
      }
      this.openHandles -= 1
      this.openResources -= 1
    }
  }

  private closeResource(
    record: ResourceRecord,
    notifyProvider: boolean,
    reason: string
  ) {
    if (this.admissionActive) this.admissionViolated = true
    if (record.state !== 'open') return false
    record.state = 'closed'
    this.openResourceRecords.delete(record)
    if (this.resourceByProviderToken.get(record.providerToken) === record) {
      this.resourceByProviderToken.delete(record.providerToken)
    }
    this.openHandles -= 1
    this.openResources -= 1
    if (notifyProvider && !record.revokeQueued) {
      this.closeProviderResource(
        record.ownerCallToken,
        record.providerToken,
        reason
      )
    }
    return true
  }

  private cancelPendingProvider(pending: PendingRequest, reason?: string) {
    if (pending.providerCancelIssued) return
    pending.providerCancelIssued = true
    this.consumePortResult(() => this.port.cancel(pending.callToken, reason))
  }

  private closeProviderResource(
    ownerCallToken: NativeCallToken,
    providerToken: NativeProviderToken,
    reason?: string
  ) {
    this.consumePortResult(() => this.port.closeResource(ownerCallToken, providerToken, reason))
  }

  private consumePortResult(
    operation: () => void | Promise<void>,
    onFailure?: () => void
  ) {
    try {
      const result = operation()
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => this.runPortFailure(onFailure))
      }
    } catch {
      this.runPortFailure(onFailure)
    }
  }

  private runPortFailure(onFailure: (() => void) | undefined) {
    try {
      onFailure?.()
    } catch {
      // No provider rejection may create a second unhandled rejection.
    }
  }

  private readLoopTime() {
    try {
      return this.loop.getCurrentTime()
    } catch {
      throw createNativeBridgeError('internal')
    }
  }

  private safeCancelNativeRequest(callToken: NativeCallToken) {
    try {
      this.loop.cancelNativeRequest(callToken)
    } catch {
      // Cleanup after a selected terminal is best-effort if the loop is fatal.
    }
  }

  private safeCancelTask(taskId: EventLoopTaskId) {
    try {
      this.loop.cancelTask(taskId)
    } catch {
      // Cleanup after a selected terminal is best-effort if the loop is fatal.
    }
  }

  private safeClearTimer(timerId: EventLoopTimerId) {
    try {
      this.loop.clearTimer(timerId)
    } catch {
      // Cleanup after a selected terminal is best-effort if the loop is fatal.
    }
  }

  private isCurrent(pending: PendingRequest) {
    return pending.state === 'active' && this.pending.get(pending.id) === pending
  }

  private normalizeAdmissionError(error: unknown) {
    return error instanceof NativeBridgeError
      ? error
      : createNativeBridgeError(this.disposed ? this.terminalCode : 'invalid_request')
  }
}

export const createNativeBridge = (
  port: NativePort,
  options: NativeBridgeOptions
): NativeBridge => {
  try {
    return new NativeBridgeController(port, options)
  } catch (error) {
    throw error instanceof NativeBridgeError
      ? error
      : createNativeBridgeError('invalid_request')
  }
}
