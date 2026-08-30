import { canonicalDigest } from './canonical-json.js'
import type {
  DeviceFieldResourceV1,
  FilesystemResourceV1,
  NetworkResourceV1,
  OpaqueHandleResourceV1,
  SystemInformationFieldResourceV1
} from './resource-types.js'
import {
  deviceField,
  digest,
  filesystemParts,
  networkParts,
  resourceDisplay,
  systemField
} from './resource-validation.js'
import { identifier, integer } from './validation.js'

const freezeResource = <T extends object>(resource: T): Readonly<T> => Object.freeze(resource)

export const canonicalizeFilesystemResource = (
  virtualUrl: unknown,
  label: unknown
): FilesystemResourceV1 => {
  const parts = filesystemParts(virtualUrl)
  const semanticResourceDigest = canonicalDigest(['filesystem', parts.rootId, parts.pathSegments])
  return freezeResource({
    ...parts,
    display: resourceDisplay(label),
    kind: 'filesystem',
    schemaVersion: 1,
    semanticId: `holo-fs:${parts.rootId}/${parts.pathSegments.join('/')}`,
    semanticResourceDigest
  })
}

export const canonicalizeNetworkResource = (
  urlValue: unknown,
  methodValue: unknown,
  queryDigest: unknown,
  label: unknown
): NetworkResourceV1 => {
  const parts = networkParts(urlValue, methodValue)
  const query = queryDigest == null ? null : digest(queryDigest)
  const semanticResourceDigest = canonicalDigest([
    'network',
    parts.method,
    parts.origin,
    parts.pathname,
    query
  ])
  return freezeResource({
    ...parts,
    ...(query === null ? {} : { queryDigest: query }),
    display: resourceDisplay(label),
    kind: 'network',
    schemaVersion: 1,
    semanticId: `${parts.method} ${parts.origin}${parts.pathname}`,
    semanticResourceDigest
  })
}

export const canonicalizeDeviceFieldResource = (
  operation: unknown,
  field: unknown,
  privacyTier: unknown,
  label: unknown
): DeviceFieldResourceV1 => {
  const parts = deviceField(operation, field, privacyTier)
  const semanticResourceDigest = canonicalDigest([
    'deviceField',
    parts.operation,
    parts.field,
    parts.privacyTier
  ])
  return freezeResource({
    ...parts,
    display: resourceDisplay(label),
    kind: 'deviceField',
    schemaVersion: 1,
    semanticId: `${parts.operation}:${parts.field}`,
    semanticResourceDigest
  })
}

export const canonicalizeOpaqueHandleResource = (
  input: Readonly<{
    bridgeIdentityDigest: unknown
    generation: unknown
    label: unknown
    resourceType: unknown
    rightsDigest: unknown
  }>
): OpaqueHandleResourceV1 => {
  const resourceType = identifier(input.resourceType)
  const generation = integer(input.generation, 1, Number.MAX_SAFE_INTEGER)
  const rightsDigest = digest(input.rightsDigest)
  const bridgeIdentityDigest = digest(input.bridgeIdentityDigest)
  const semanticResourceDigest = canonicalDigest([
    'opaqueHandle',
    resourceType,
    generation,
    rightsDigest,
    bridgeIdentityDigest
  ])
  return freezeResource({
    bridgeIdentityDigest,
    display: resourceDisplay(input.label),
    generation,
    kind: 'opaqueHandle',
    resourceType,
    rightsDigest,
    schemaVersion: 1,
    semanticId: `${resourceType}:${bridgeIdentityDigest.slice(0, 16)}`,
    semanticResourceDigest
  })
}

export const canonicalizeSystemInformationFieldResource = (
  fieldValue: unknown,
  label: unknown
): SystemInformationFieldResourceV1 => {
  const field = systemField(fieldValue)
  const semanticResourceDigest = canonicalDigest(['systemField', field])
  return freezeResource({
    display: resourceDisplay(label),
    field,
    kind: 'systemField',
    schemaVersion: 1,
    semanticId: `system-field:${field}`,
    semanticResourceDigest
  })
}
