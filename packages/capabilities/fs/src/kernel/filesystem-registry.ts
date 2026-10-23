import { allOf, inheritedCapability, operation } from '@holonomyjs/runtime/kernel/operation-types'
import type { OperationDescriptorV1, OperationResultVariantV1 } from '@holonomyjs/runtime/kernel/operation-types'
import { FILESYSTEM_METADATA_OPERATION_ROWS_V1 } from './filesystem-registry-metadata-rows.js'
import { FILESYSTEM_CORE_OPERATION_ROWS_V1 } from './filesystem-registry-rows.js'
import { FILESYSTEM_TAIL_OPERATION_ROWS_V1 } from './filesystem-registry-tail-rows.js'

export type FilesystemOperationV1 =
  | 'filesystem.directory.create'
  | 'filesystem.directory.close'
  | 'filesystem.directory.open'
  | 'filesystem.directory.read'
  | 'filesystem.directory.sync'
  | 'filesystem.entry.rename'
  | 'filesystem.entry.unlink'
  | 'filesystem.file.close'
  | 'filesystem.file.datasync'
  | 'filesystem.file.open'
  | 'filesystem.file.read'
  | 'filesystem.file.sync'
  | 'filesystem.file.truncate'
  | 'filesystem.file.write'
  | 'filesystem.metadata.access'
  | 'filesystem.metadata.chmod'
  | 'filesystem.metadata.lstat'
  | 'filesystem.metadata.stat'
  | 'filesystem.metadata.utimes'
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
  const mutations: Readonly<Record<string, readonly [string, string]>> = {
    FsChmodPromiseArgsV1: ['FsChmodArgsV1', 'FsChmodReadbackArgsV1'],
    FsHandleChmodPromiseArgsV1: ['FsHandleChmodArgsV1', 'FsHandleChmodReadbackArgsV1'],
    FsUtimesPromiseArgsV1: ['FsUtimesArgsV1', 'FsUtimesReadbackArgsV1'],
    FsHandleTimesPromiseArgsV1: ['FsHandleTimesArgsV1', 'FsHandleTimesReadbackArgsV1'],
    FsTruncatePromiseArgsV1: ['FsTruncateArgsV1', 'FsTruncateReadbackArgsV1'],
    FsHandleTruncatePromiseArgsV1: ['FsHandleTruncateArgsV1', 'FsHandleTruncateReadbackArgsV1']
  }
  const mutation = mutations[argsSchemaId]
  if (mutation != null) {
    return [
      { resultSchemaId: 'void', whenArgumentsSchemaId: mutation[0] },
      {
        resultSchemaId: argsSchemaId === 'FsChmodPromiseArgsV1' ||
            argsSchemaId === 'FsHandleChmodPromiseArgsV1'
          ? 'FsChmodMetadataResultV1'
          : 'FsExactMetadataResultV1',
        whenArgumentsSchemaId: mutation[1]
      }
    ]
  }
  return undefined
}

export const FILESYSTEM_OPERATION_REGISTRY_V1: readonly OperationDescriptorV1[] = Object.freeze(
  [...FILESYSTEM_CORE_OPERATION_ROWS_V1, ...FILESYSTEM_TAIL_OPERATION_ROWS_V1, ...FILESYSTEM_METADATA_OPERATION_ROWS_V1]
    .map((
      [member, mode, argsSchemaId, resultSchemaId, operationId, right, deliverySchemaId, explicitModule],
      index
    ) =>
      operation({
        argsSchemaId,
        capability: operationId.endsWith('.close') || operationId === 'filesystem.directory.sync' ||
            operationId === 'filesystem.file.sync' || operationId === 'filesystem.file.datasync'
          ? inheritedCapability
          : allOf(`fs-${right}`, 'host.fs'),
        deliverySchemaId,
        interception: operationId.endsWith('.close') ? 'systemOnly' : 'host',
        kind: kind(operationId),
        limitsOwner: 'FilesystemLimitsV2',
        member,
        modes: [mode],
        module: explicitModule ?? (promiseRows.has(index) ? 'node:fs/promises' : 'node:fs'),
        operation: operationId,
        resourceSchemaId: operationId === 'filesystem.directory.close' || operationId === 'filesystem.directory.sync' ||
            member === 'directory.chmod'
          ? 'OpaqueDirectoryHandleResourceV1'
          : operationId === 'filesystem.file.close' ||
              operationId === 'filesystem.file.sync' || operationId === 'filesystem.file.datasync'
          ? 'OpaqueFileHandleResourceV1'
          : 'FilesystemResourceV1',
        resultSchemaId,
        resultVariants: resultVariants(argsSchemaId)
      })
    )
)
