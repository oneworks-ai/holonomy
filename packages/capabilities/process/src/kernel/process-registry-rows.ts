import type { InterceptionV1, OperationKindV1 } from '@holonomyjs/runtime/kernel/operation-types'
import type { ProcessOperationV1 } from './process-registry.js'

type Row = readonly [
  member: string,
  operation: ProcessOperationV1,
  kind: OperationKindV1,
  interception: InterceptionV1,
  args: string,
  result: string,
  delivery: string,
  limits: string
]

export const PROCESS_INHERITED_ROWS_V1 = Object.freeze(
  [
    [
      'ChildProcess.stdin.write',
      'process.stdin.write',
      'write',
      'host',
      'FsDataV1',
      'boolean',
      'ProcessStdinDeliveryV1',
      'stdinBytes/openPipes'
    ],
    [
      'ChildProcess.stdin.end',
      'process.stdin.end',
      'write',
      'systemOnly',
      'EmptyArgsV1',
      'ChildProcessStdinFacadeV1',
      'ProcessStdinEndDeliveryV1',
      'stdin terminal'
    ],
    [
      'ChildProcess.stdin.destroy',
      'process.stdio.destroy',
      'close',
      'systemOnly',
      'EmptyArgsV1',
      'ChildProcessStdinFacadeV1',
      'ProcessSyncDeliveryV1',
      'idempotent'
    ],
    [
      'stdout/stderr.pause',
      'process.stdio.pause',
      'invoke',
      'systemOnly',
      'EmptyArgsV1',
      'ChildProcessReadableFacadeV1',
      'ProcessSyncDeliveryV1',
      'queue cap'
    ],
    [
      'stdout/stderr.resume',
      'process.stdio.resume',
      'invoke',
      'systemOnly',
      'EmptyArgsV1',
      'ChildProcessReadableFacadeV1',
      'ProcessSyncDeliveryV1',
      'sequence'
    ],
    [
      'stdout/stderr.destroy',
      'process.stdio.destroy',
      'close',
      'systemOnly',
      'EmptyArgsV1',
      'ChildProcessReadableFacadeV1',
      'ProcessSyncDeliveryV1',
      'idempotent'
    ],
    [
      'ChildProcess.events',
      'process.wait',
      'subscribe',
      'systemOnly',
      'ChildProcessResourceStateV1',
      'ChildProcessEventV1',
      'ProcessEventDeliveryV1',
      'stdout/stderr/event cap'
    ],
    [
      'stdout/stderr.events',
      'process.wait',
      'subscribe',
      'systemOnly',
      'ChildProcessReadableFacadeV1',
      'ChildProcessReadableEventV1',
      'ProcessReadableEventDeliveryV1',
      'stdout/stderr/queue cap'
    ],
    [
      'ChildProcess.finalizer',
      'process.resource.close',
      'close',
      'systemOnly',
      'EmptyArgsV1',
      'void',
      'ProcessSyncDeliveryV1',
      'idempotent'
    ]
  ] as const satisfies readonly Row[]
)
