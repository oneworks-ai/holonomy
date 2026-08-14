import type { FilesystemRegistryRowV1 } from './filesystem-registry-rows.js'

export const FILESYSTEM_TAIL_OPERATION_ROWS_V1 = Object.freeze(
  [
    [
      'lstatSync',
      'sync',
      'FsStatArgsV1',
      'VirtualStatsV1',
      'filesystem.metadata.lstat',
      'read',
      'SyncResultDeliveryV1'
    ],
    [
      'lstat',
      'callback',
      'FsStatArgsV1',
      'VirtualStatsV1',
      'filesystem.metadata.lstat',
      'read',
      'CallbackResultDeliveryV1'
    ],
    [
      'lstat',
      'promise',
      'FsStatArgsV1',
      'VirtualStatsV1',
      'filesystem.metadata.lstat',
      'read',
      'PromiseResultDeliveryV1'
    ],
    [
      'readdirSync',
      'sync',
      'FsReaddirArgsV1',
      'FsReaddirResultV1',
      'filesystem.directory.read',
      'list',
      'SyncVariantDeliveryV1'
    ],
    [
      'readdir',
      'callback',
      'FsReaddirArgsV1',
      'FsReaddirResultV1',
      'filesystem.directory.read',
      'list',
      'FsReaddirCallbackDeliveryV1'
    ],
    [
      'readdir',
      'promise',
      'FsReaddirArgsV1',
      'FsReaddirResultV1',
      'filesystem.directory.read',
      'list',
      'PromiseVariantDeliveryV1'
    ],
    [
      'mkdirSync',
      'sync',
      'FsMkdirArgsV1',
      'FsMkdirResultV1',
      'filesystem.directory.create',
      'create',
      'SyncVariantDeliveryV1'
    ],
    [
      'mkdir',
      'callback',
      'FsMkdirArgsV1',
      'FsMkdirResultV1',
      'filesystem.directory.create',
      'create',
      'FsMkdirCallbackDeliveryV1'
    ],
    [
      'mkdir',
      'promise',
      'FsMkdirArgsV1',
      'FsMkdirResultV1',
      'filesystem.directory.create',
      'create',
      'PromiseVariantDeliveryV1'
    ],
    ['renameSync', 'sync', 'FsRenameArgsV1', 'void', 'filesystem.entry.rename', 'move', 'SyncVoidDeliveryV1'],
    ['rename', 'callback', 'FsRenameArgsV1', 'void', 'filesystem.entry.rename', 'move', 'CallbackVoidDeliveryV1'],
    ['rename', 'promise', 'FsRenameArgsV1', 'void', 'filesystem.entry.rename', 'move', 'PromiseVoidDeliveryV1'],
    ['unlinkSync', 'sync', 'FsUnlinkArgsV1', 'void', 'filesystem.entry.unlink', 'delete', 'SyncVoidDeliveryV1'],
    ['unlink', 'callback', 'FsUnlinkArgsV1', 'void', 'filesystem.entry.unlink', 'delete', 'CallbackVoidDeliveryV1'],
    ['unlink', 'promise', 'FsUnlinkArgsV1', 'void', 'filesystem.entry.unlink', 'delete', 'PromiseVoidDeliveryV1'],
    ['watch', 'sync', 'FsWatchArgsV1', 'FsWatcherV1', 'filesystem.watch.subscribe', 'watch', 'FsWatcherDeliveryV1'],
    [
      'watch',
      'sync',
      'FsWatchArgsV1',
      'FsWatchIteratorV1',
      'filesystem.watch.subscribe',
      'watch',
      'FsWatchIteratorDeliveryV1'
    ],
    ['FSWatcher.close', 'sync', 'EmptyArgsV1', 'void', 'filesystem.watch.close', 'handle', 'SyncVoidDeliveryV1']
  ] as const satisfies readonly FilesystemRegistryRowV1[]
)
