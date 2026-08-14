import { FILESYSTEM_CORE_OPERATION_ROWS_V1 } from './filesystem-registry-rows.js'
import { FILESYSTEM_TAIL_OPERATION_ROWS_V1 } from './filesystem-registry-tail-rows.js'
import { allOf, inheritedCapability, operation } from './operation-types.js'
import type { OperationDescriptorV1, OperationResultVariantV1 } from './operation-types.js'

export type FilesystemOperationV1 =
  | 'filesystem.directory.create'
  | 'filesystem.directory.read'
  | 'filesystem.entry.rename'
  | 'filesystem.entry.unlink'
  | 'filesystem.file.close'
  | 'filesystem.file.open'
  | 'filesystem.file.read'
  | 'filesystem.file.write'
  | 'filesystem.metadata.lstat'
  | 'filesystem.metadata.stat'
  | 'filesystem.watch.close'
  | 'filesystem.watch.subscribe'

const promiseRows = new Set([2, 3, 6, 7, 10, 13, 16, 17, 20, 23, 26, 29, 32, 34])
const kind = (operationId: FilesystemOperationV1) => {
  if (operationId.endsWith('.close')) return 'close' as const
  if (operationId.endsWith('.open')) return 'open' as const
  if (operationId.endsWith('.subscribe')) return 'subscribe' as const
  if (operationId.endsWith('.write')) return 'write' as const
  return 'invoke' as const
}

const resultVariants = (argsSchemaId: string): readonly OperationResultVariantV1[] | undefined => {
  if (argsSchemaId === 'FsReadFileSyncArgsV1') {
    return [
      { resultSchemaId: 'RuntimeBufferV1', whenArgumentsSchemaId: 'FsReadFileSyncBufferArgsV1' },
      { resultSchemaId: 'string', whenArgumentsSchemaId: 'FsReadFileSyncStringArgsV1' }
    ]
  }
  if (argsSchemaId === 'FsReadFileAsyncArgsV1') {
    return [
      { resultSchemaId: 'RuntimeBufferV1', whenArgumentsSchemaId: 'FsReadFileAsyncBufferArgsV1' },
      { resultSchemaId: 'string', whenArgumentsSchemaId: 'FsReadFileAsyncStringArgsV1' }
    ]
  }
  if (argsSchemaId === 'FsFileHandleReadArgsV1') {
    return [
      { resultSchemaId: 'RuntimeBufferV1', whenArgumentsSchemaId: 'FsFileHandleReadBufferArgsV1' },
      { resultSchemaId: 'string', whenArgumentsSchemaId: 'FsFileHandleReadStringArgsV1' }
    ]
  }
  if (argsSchemaId === 'FsReaddirArgsV1') {
    return [
      { resultSchemaId: 'FsReaddirNamesResultV1', whenArgumentsSchemaId: 'FsReaddirNamesArgsV1' },
      { resultSchemaId: 'FsReaddirDirentsResultV1', whenArgumentsSchemaId: 'FsReaddirDirentsArgsV1' }
    ]
  }
  if (argsSchemaId === 'FsMkdirArgsV1') {
    return [
      { resultSchemaId: 'void', whenArgumentsSchemaId: 'FsMkdirNonRecursiveArgsV1' },
      { resultSchemaId: 'FsMkdirRecursiveResultV1', whenArgumentsSchemaId: 'FsMkdirRecursiveArgsV1' }
    ]
  }
  return undefined
}

export const FILESYSTEM_OPERATION_REGISTRY_V1: readonly OperationDescriptorV1[] = Object.freeze(
  [...FILESYSTEM_CORE_OPERATION_ROWS_V1, ...FILESYSTEM_TAIL_OPERATION_ROWS_V1].map((
    [member, mode, argsSchemaId, resultSchemaId, operationId, right, deliverySchemaId],
    index
  ) =>
    operation({
      argsSchemaId,
      capability: operationId.endsWith('.close')
        ? inheritedCapability
        : allOf(`fs-${right}`, 'host.fs'),
      deliverySchemaId,
      interception: operationId.endsWith('.close') ? 'systemOnly' : 'host',
      kind: kind(operationId),
      limitsOwner: 'FilesystemLimitsV2',
      member,
      modes: [mode],
      module: promiseRows.has(index) ? 'node:fs/promises' : 'node:fs',
      operation: operationId,
      resourceSchemaId: operationId === 'filesystem.file.close'
        ? 'OpaqueFileHandleResourceV1'
        : 'FilesystemResourceV1',
      resultSchemaId,
      resultVariants: resultVariants(argsSchemaId)
    })
  )
)
