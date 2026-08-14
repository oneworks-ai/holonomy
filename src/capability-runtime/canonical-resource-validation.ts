import { canonicalJson } from './canonical-json.js'
import {
  canonicalizeProcessInstanceResource,
  canonicalizeProcessNetworkEndpointResource,
  canonicalizeProgramExecutableResource,
  canonicalizeShellExecutableResource
} from './canonical-process-resources.js'
import {
  canonicalizeDeviceFieldResource,
  canonicalizeFilesystemResource,
  canonicalizeNetworkResource,
  canonicalizeOpaqueHandleResource,
  canonicalizeSystemInformationFieldResource
} from './canonical-resources.js'
import { invalidPolicy } from './errors.js'
import type { CanonicalResourceV1 } from './resource-types.js'
import { exact, inspectJsonShape, required } from './validation.js'

const displayLabel = (value: unknown): unknown => {
  const display = exact(value, ['label'])
  return required(display, 'label')
}

const matches = <T extends CanonicalResourceV1>(input: unknown, canonical: T): T => {
  if (canonicalJson(input as never) !== canonicalJson(canonical as never)) return invalidPolicy()
  return canonical
}

const networkUrl = (origin: unknown, pathname: unknown): string => {
  if (typeof origin !== 'string' || typeof pathname !== 'string') return invalidPolicy()
  return `${origin}${pathname}`
}

export const validateCanonicalResourceV1 = (value: unknown): CanonicalResourceV1 => {
  inspectJsonShape(value)
  const base = exact(value, [
    'argvDigest',
    'bridgeIdentityDigest',
    'commandDigest',
    'cwdSemanticResourceDigest',
    'display',
    'environmentNamesDigest',
    'environmentScope',
    'executableId',
    'executableSemanticResourceDigest',
    'field',
    'generation',
    'hostname',
    'invocation',
    'kind',
    'method',
    'operation',
    'origin',
    'pathSegments',
    'pathname',
    'privacyTier',
    'port',
    'processResourceId',
    'queryDigest',
    'resourceType',
    'rightsDigest',
    'rootId',
    'schemaVersion',
    'semanticId',
    'semanticResourceDigest',
    'shellExecutableId',
    'stdioDigest',
    'transport',
    'virtualUrl'
  ])
  if (required(base, 'schemaVersion') !== 1) return invalidPolicy()
  const label = displayLabel(required(base, 'display'))
  switch (required(base, 'kind')) {
    case 'filesystem':
      return matches(value, canonicalizeFilesystemResource(required(base, 'virtualUrl'), label))
    case 'network':
      return matches(
        value,
        canonicalizeNetworkResource(
          networkUrl(required(base, 'origin'), required(base, 'pathname')),
          required(base, 'method'),
          base.queryDigest,
          label
        )
      )
    case 'deviceField':
      return matches(
        value,
        canonicalizeDeviceFieldResource(
          required(base, 'operation'),
          required(base, 'field'),
          required(base, 'privacyTier'),
          label
        )
      )
    case 'opaqueHandle':
      return matches(
        value,
        canonicalizeOpaqueHandleResource({
          bridgeIdentityDigest: required(base, 'bridgeIdentityDigest'),
          generation: required(base, 'generation'),
          label,
          resourceType: required(base, 'resourceType'),
          rightsDigest: required(base, 'rightsDigest')
        })
      )
    case 'processExecutable':
      return validateProcessExecutable(base, value, label)
    case 'processInstance':
      return matches(
        value,
        canonicalizeProcessInstanceResource({
          executableSemanticResourceDigest: required(base, 'executableSemanticResourceDigest'),
          generation: required(base, 'generation'),
          label,
          processResourceId: required(base, 'processResourceId')
        })
      )
    case 'processNetworkEndpoint':
      return matches(
        value,
        canonicalizeProcessNetworkEndpointResource({
          hostname: required(base, 'hostname'),
          label,
          port: required(base, 'port'),
          transport: required(base, 'transport')
        })
      )
    case 'systemField':
      return matches(
        value,
        canonicalizeSystemInformationFieldResource(required(base, 'field'), label)
      )
    default:
      return invalidPolicy()
  }
}

const validateProcessExecutable = (
  input: Record<string, unknown>,
  value: unknown,
  label: unknown
): CanonicalResourceV1 => {
  const shared = {
    cwdSemanticResourceDigest: input.cwdSemanticResourceDigest,
    environmentNamesDigest: required(input, 'environmentNamesDigest'),
    environmentScope: required(input, 'environmentScope'),
    label,
    stdioDigest: required(input, 'stdioDigest')
  }
  if (required(input, 'invocation') === 'program') {
    return matches(
      value,
      canonicalizeProgramExecutableResource({
        ...shared,
        argvDigest: required(input, 'argvDigest'),
        executableId: required(input, 'executableId')
      })
    )
  }
  if (input.invocation !== 'shell') return invalidPolicy()
  return matches(
    value,
    canonicalizeShellExecutableResource({
      ...shared,
      commandDigest: required(input, 'commandDigest'),
      shellExecutableId: required(input, 'shellExecutableId')
    })
  )
}
