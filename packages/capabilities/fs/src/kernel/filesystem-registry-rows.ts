import type { InvocationModeV1 } from '@holonomyjs/runtime/kernel/operation-types'
import type { FilesystemOperationV1 } from './filesystem-registry.js'

export type FilesystemRegistryRowV1 = readonly [
  member: string,
  mode: InvocationModeV1,
  args: string,
  result: string,
  operation: FilesystemOperationV1,
  right: string,
  delivery: string
]

export const FILESYSTEM_CORE_OPERATION_ROWS_V1 = Object.freeze(
  [
    [
      'readFileSync',
      'sync',
      'FsReadFileSyncArgsV1',
      'FsReadResultV1',
      'filesystem.file.read',
      'read',
      'SyncVariantDeliveryV1'
    ],
    [
      'readFile',
      'callback',
      'FsReadFileAsyncArgsV1',
      'FsReadResultV1',
      'filesystem.file.read',
      'read',
      'FsReadCallbackDeliveryV1'
    ],
    [
      'readFile',
      'promise',
      'FsReadFileAsyncArgsV1',
      'FsReadResultV1',
      'filesystem.file.read',
      'read',
      'PromiseVariantDeliveryV1'
    ],
    [
      'FileHandle.readFile',
      'promise',
      'FsFileHandleReadArgsV1',
      'FsReadResultV1',
      'filesystem.file.read',
      'handle-read',
      'PromiseVariantDeliveryV1'
    ],
    ['writeFileSync', 'sync', 'FsWriteFileSyncArgsV1', 'void', 'filesystem.file.write', 'write', 'SyncVoidDeliveryV1'],
    [
      'writeFile',
      'callback',
      'FsWriteFileAsyncArgsV1',
      'void',
      'filesystem.file.write',
      'write',
      'CallbackVoidDeliveryV1'
    ],
    [
      'writeFile',
      'promise',
      'FsWriteFileAsyncArgsV1',
      'void',
      'filesystem.file.write',
      'write',
      'PromiseVoidDeliveryV1'
    ],
    [
      'FileHandle.writeFile',
      'promise',
      'FsFileHandleWriteArgsV1',
      'void',
      'filesystem.file.write',
      'handle-write',
      'PromiseVoidDeliveryV1'
    ],
    ['openSync', 'sync', 'FsOpenArgsV1', 'VirtualFdV1', 'filesystem.file.open', 'flag-rights', 'SyncResultDeliveryV1'],
    [
      'open',
      'callback',
      'FsOpenArgsV1',
      'VirtualFdV1',
      'filesystem.file.open',
      'flag-rights',
      'CallbackResultDeliveryV1'
    ],
    [
      'open',
      'promise',
      'FsOpenArgsV1',
      'FileHandleV1',
      'filesystem.file.open',
      'flag-rights',
      'PromiseResultDeliveryV1'
    ],
    ['closeSync', 'sync', 'FsCloseArgsV1', 'void', 'filesystem.file.close', 'handle', 'SyncVoidDeliveryV1'],
    ['close', 'callback', 'FsCloseArgsV1', 'void', 'filesystem.file.close', 'handle', 'CallbackVoidDeliveryV1'],
    ['FileHandle.close', 'promise', 'EmptyArgsV1', 'void', 'filesystem.file.close', 'handle', 'PromiseVoidDeliveryV1'],
    ['statSync', 'sync', 'FsStatArgsV1', 'VirtualStatsV1', 'filesystem.metadata.stat', 'read', 'SyncResultDeliveryV1'],
    [
      'stat',
      'callback',
      'FsStatArgsV1',
      'VirtualStatsV1',
      'filesystem.metadata.stat',
      'read',
      'CallbackResultDeliveryV1'
    ],
    [
      'stat',
      'promise',
      'FsStatArgsV1',
      'VirtualStatsV1',
      'filesystem.metadata.stat',
      'read',
      'PromiseResultDeliveryV1'
    ],
    [
      'FileHandle.stat',
      'promise',
      'FsFileHandleStatArgsV1',
      'VirtualStatsV1',
      'filesystem.metadata.stat',
      'handle-read',
      'PromiseResultDeliveryV1'
    ]
  ] as const satisfies readonly FilesystemRegistryRowV1[]
)
