import type { InvocationModeV1 } from './operation-types.js'

export type CallbackSuccessDeliveryV1 =
  | Readonly<{ kind: 'result'; resultSchemaId: string }>
  | Readonly<{ kind: 'tuple'; tupleSchemaId: string }>
  | Readonly<{ kind: 'void' }>
  | Readonly<{
    kind: 'variants'
    variants: readonly Readonly<{
      delivery: Exclude<CallbackSuccessDeliveryV1, { kind: 'variants' }>
      whenArgumentsSchemaId: string
    }>[]
  }>

export type CallbackFailureDeliveryV1 =
  | Readonly<{ kind: 'errorAndTuple'; tupleSchemaId: string }>
  | Readonly<{ kind: 'errorOnly' }>

export interface CallbackDeliveryV1 {
  readonly errorFirst: true
  readonly failure: CallbackFailureDeliveryV1
  readonly success: CallbackSuccessDeliveryV1
}

export type FacadeDeliveryV1 =
  | Readonly<{
    callback?: CallbackDeliveryV1
    immediateResultSchemaId?: string
    invocationModes: readonly InvocationModeV1[]
    kind: 'invocation'
    resourceEvents?: Readonly<{ eventSchemaId: string; terminalEvent: string }>
  }>
  | Readonly<{
    eventSchemaId: string
    kind: 'resourceEvents'
    terminalEvent: string
  }>

const errorOnly = Object.freeze({ kind: 'errorOnly' as const })
const callback = (
  success: CallbackSuccessDeliveryV1,
  failure: CallbackFailureDeliveryV1 = errorOnly
): CallbackDeliveryV1 => Object.freeze({ errorFirst: true, failure, success })
const invocation = (
  invocationModes: readonly InvocationModeV1[],
  options: Readonly<{
    callback?: CallbackDeliveryV1
    immediateResultSchemaId?: string
    resourceEvents?: Readonly<{ eventSchemaId: string; terminalEvent: string }>
  }> = {}
): FacadeDeliveryV1 =>
  Object.freeze({
    ...options,
    invocationModes: Object.freeze([...invocationModes]),
    kind: 'invocation' as const
  })
const events = (eventSchemaId: string): FacadeDeliveryV1 =>
  Object.freeze({
    eventSchemaId,
    kind: 'resourceEvents' as const,
    terminalEvent: 'close'
  })

const sync = invocation(['sync'])
const promise = invocation(['promise'])
const callbackResult = invocation(['callback'], {
  callback: callback({ kind: 'result', resultSchemaId: '$operation.resultSchemaId' })
})
const callbackVoid = invocation(['callback'], { callback: callback({ kind: 'void' }) })
const callbackVariants = (
  variants: readonly Readonly<{
    delivery: Exclude<CallbackSuccessDeliveryV1, { kind: 'variants' }>
    whenArgumentsSchemaId: string
  }>[]
) =>
  invocation(['callback'], {
    callback: callback({
      kind: 'variants',
      variants: Object.freeze(variants.map(item => Object.freeze({ ...item })))
    })
  })

export const FACADE_DELIVERY_REGISTRY_V1: Readonly<Record<string, FacadeDeliveryV1>> = Object.freeze({
  CallbackResultDeliveryV1: callbackResult,
  CallbackVoidDeliveryV1: callbackVoid,
  DeviceSubscriptionDeliveryV1: invocation(['promise'], {
    immediateResultSchemaId: 'DeviceSubscriptionV1',
    resourceEvents: Object.freeze({
      eventSchemaId: 'HoloDeviceEventV1',
      terminalEvent: 'closed'
    })
  }),
  FsMkdirCallbackDeliveryV1: callbackVariants([
    { delivery: { kind: 'void' }, whenArgumentsSchemaId: 'FsMkdirNonRecursiveArgsV1' },
    {
      delivery: { kind: 'result', resultSchemaId: 'FsMkdirRecursiveResultV1' },
      whenArgumentsSchemaId: 'FsMkdirRecursiveArgsV1'
    }
  ]),
  FsReadCallbackDeliveryV1: callbackVariants([
    {
      delivery: { kind: 'result', resultSchemaId: 'RuntimeBufferV1' },
      whenArgumentsSchemaId: 'FsReadFileAsyncBufferArgsV1'
    },
    {
      delivery: { kind: 'result', resultSchemaId: 'string' },
      whenArgumentsSchemaId: 'FsReadFileAsyncStringArgsV1'
    }
  ]),
  FsReaddirCallbackDeliveryV1: callbackVariants([
    {
      delivery: { kind: 'result', resultSchemaId: 'FsReaddirNamesResultV1' },
      whenArgumentsSchemaId: 'FsReaddirNamesArgsV1'
    },
    {
      delivery: { kind: 'result', resultSchemaId: 'FsReaddirDirentsResultV1' },
      whenArgumentsSchemaId: 'FsReaddirDirentsArgsV1'
    }
  ]),
  FsWatchIteratorDeliveryV1: invocation(['sync'], {
    immediateResultSchemaId: 'FsWatchIteratorV1',
    resourceEvents: Object.freeze({
      eventSchemaId: 'VirtualFsWatcherDeliveryV1',
      terminalEvent: 'close'
    })
  }),
  FsWatcherDeliveryV1: invocation(['sync'], {
    immediateResultSchemaId: 'FsWatcherV1',
    resourceEvents: Object.freeze({
      eventSchemaId: 'VirtualFsWatcherDeliveryV1',
      terminalEvent: 'close'
    })
  }),
  ProcessEventDeliveryV1: events('ChildProcessEventV1'),
  ProcessExecDeliveryV1: invocation(['callback'], {
    callback: callback(
      { kind: 'tuple', tupleSchemaId: 'ProcessExecSuccessTupleV1' },
      { kind: 'errorAndTuple', tupleSchemaId: 'ProcessExecSuccessTupleV1' }
    ),
    immediateResultSchemaId: 'ChildProcessFacadeV1'
  }),
  ProcessReadableEventDeliveryV1: events('ChildProcessReadableEventV1'),
  ProcessStdinDeliveryV1: invocation(['callback'], {
    callback: callback({ kind: 'void' }),
    immediateResultSchemaId: 'boolean',
    resourceEvents: Object.freeze({
      eventSchemaId: 'ChildProcessStdinEventV1',
      terminalEvent: 'close'
    })
  }),
  ProcessStdinEndDeliveryV1: invocation(['callback'], {
    callback: callback({ kind: 'void' }),
    immediateResultSchemaId: 'ChildProcessStdinFacadeV1',
    resourceEvents: Object.freeze({
      eventSchemaId: 'ChildProcessStdinEventV1',
      terminalEvent: 'close'
    })
  }),
  ProcessSyncDeliveryV1: sync,
  PromiseResultDeliveryV1: promise,
  PromiseVariantDeliveryV1: promise,
  PromiseVoidDeliveryV1: promise,
  SyncNeverDeliveryV1: sync,
  SyncResultDeliveryV1: sync,
  SyncVariantDeliveryV1: sync,
  SyncVoidDeliveryV1: sync,
  SystemSyncDeliveryV1: sync
})
