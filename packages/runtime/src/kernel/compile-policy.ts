import { normalizeFilesystemSandbox } from '@holonomyjs/capability-fs/kernel/normalize-filesystem'
import { normalizeNetworkSandbox } from '@holonomyjs/capability-network/kernel/normalize-network'
import { normalizeProcessSandbox } from '@holonomyjs/capability-process/kernel/normalize-process'
import {
  normalizeDeviceSandbox,
  normalizeDiagnosticsSandbox,
  normalizeSystemSandbox
} from '@holonomyjs/capability-system/kernel/normalize-host'
import { canonicalDigest, canonicalJson } from './canonical-json.js'
import type { CanonicalJsonValue } from './canonical-json.js'
import { CapabilityContractError, invalidPolicy } from './errors.js'
import { normalizeCodeGenerationSandbox, normalizeInspectorSandbox } from './normalize-code.js'
import { DEFAULT_SANDBOX_POLICY_V2 } from './policy-defaults.js'
import type { CompiledSandboxPolicyV2, SandboxPolicyV2 } from './sandbox-policy.js'
import {
  MAX_POLICY_BYTES,
  boolean,
  deepFreeze,
  exact,
  inspectJsonShape,
  literal,
  required,
  utf8ByteLength
} from './validation.js'

const TOP_LEVEL = [
  'codeGeneration',
  'device',
  'diagnostics',
  'filesystem',
  'inspector',
  'network',
  'process',
  'schemaVersion',
  'systemInformation'
] as const

const freezeCompiled = (policy: SandboxPolicyV2): CompiledSandboxPolicyV2 => {
  const frozen = deepFreeze(policy)
  const canonical = frozen as unknown as CanonicalJsonValue
  const serialized = canonicalJson(canonical)
  return Object.freeze({ canonicalJson: serialized, digest: canonicalDigest(canonical), policy: frozen })
}

const compileV2 = (value: unknown): CompiledSandboxPolicyV2 => {
  const input = exact(value, TOP_LEVEL)
  if (required(input, 'schemaVersion') !== 2) {
    throw new CapabilityContractError('runtime.policy_version_unsupported')
  }
  const defaults = DEFAULT_SANDBOX_POLICY_V2
  const filesystem = normalizeFilesystemSandbox(input.filesystem ?? defaults.filesystem)
  return freezeCompiled({
    codeGeneration: normalizeCodeGenerationSandbox(input.codeGeneration ?? defaults.codeGeneration),
    device: normalizeDeviceSandbox(input.device ?? defaults.device),
    diagnostics: normalizeDiagnosticsSandbox(input.diagnostics ?? defaults.diagnostics),
    filesystem,
    inspector: normalizeInspectorSandbox(input.inspector ?? defaults.inspector),
    network: normalizeNetworkSandbox(input.network ?? defaults.network),
    process: normalizeProcessSandbox(input.process ?? defaults.process, filesystem),
    schemaVersion: 2,
    systemInformation: normalizeSystemSandbox(input.systemInformation ?? defaults.systemInformation)
  })
}

interface LegacyNetworkLimitsV1 {
  maxChunkBytes: number
  maxConcurrentConnections: number
  maxHeaderBytes: number
  maxHeaders: number
  maxRequestBodyBytes: number
  maxResponseBodyBytes: number
  maxUrlBytes: number
  socketTimeoutMs: number
}

interface LegacySandboxPolicyV1 {
  filesystem: { access: 'none' }
  network:
    | { access: 'none' }
    | {
      access: 'mockOnly' | 'restricted'
      allowedOrigins: string[]
      allowedSchemes: ('http' | 'https')[]
      allowPrivateNetwork: boolean
      limits: LegacyNetworkLimitsV1
    }
  schemaVersion: 1
}

const migrateV1 = (value: unknown): CompiledSandboxPolicyV2 => {
  const input = exact(value, ['filesystem', 'network', 'schemaVersion'])
  if (required(input, 'schemaVersion') !== 1) {
    throw new CapabilityContractError('runtime.policy_version_unsupported')
  }
  const filesystem = exact(required(input, 'filesystem'), ['access'])
  if (Object.keys(filesystem).length !== 1 || required(filesystem, 'access') !== 'none') {
    return invalidPolicy()
  }
  const networkInput = exact(required(input, 'network'), [
    'access',
    'allowedOrigins',
    'allowedSchemes',
    'allowPrivateNetwork',
    'limits'
  ])
  const access = literal(required(networkInput, 'access'), ['mockOnly', 'none', 'restricted'] as const)
  let legacyNetwork: LegacySandboxPolicyV1['network']
  if (access === 'none') {
    if (Object.keys(networkInput).length !== 1) return invalidPolicy()
    legacyNetwork = { access }
  } else {
    const limitsInput = exact(required(networkInput, 'limits'), [
      'maxChunkBytes',
      'maxConcurrentConnections',
      'maxHeaderBytes',
      'maxHeaders',
      'maxRequestBodyBytes',
      'maxResponseBodyBytes',
      'maxUrlBytes',
      'socketTimeoutMs'
    ])
    legacyNetwork = {
      access,
      allowedOrigins: required(networkInput, 'allowedOrigins') as string[],
      allowedSchemes: required(networkInput, 'allowedSchemes') as ('http' | 'https')[],
      allowPrivateNetwork: boolean(required(networkInput, 'allowPrivateNetwork')),
      limits: Object.fromEntries(
        Object.keys(limitsInput).map(key => [key, limitsInput[key]])
      ) as unknown as LegacyNetworkLimitsV1
    }
  }
  const network = legacyNetwork.access === 'none'
    ? { access: 'none' as const }
    : {
      ...legacyNetwork,
      limits: { ...legacyNetwork.limits, maxRedirects: 10 },
      requestBodyInspection: { access: 'none' as const }
    }
  return compileV2({
    ...DEFAULT_SANDBOX_POLICY_V2,
    network
  })
}

export const compileSandboxPolicyV2 = (value?: unknown): CompiledSandboxPolicyV2 => {
  if (value === undefined) return freezeCompiled(DEFAULT_SANDBOX_POLICY_V2)
  inspectJsonShape(value)
  const input = exact(value, TOP_LEVEL)
  const version = input.schemaVersion
  if (version === 2) return compileV2(input)
  if (version === 1) return migrateV1(input)
  throw new CapabilityContractError('runtime.policy_version_unsupported')
}

export const parseSandboxPolicyJson = (source: string): CompiledSandboxPolicyV2 => {
  if (typeof source !== 'string' || utf8ByteLength(source) > MAX_POLICY_BYTES) return invalidPolicy()
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return invalidPolicy()
  }
  return compileSandboxPolicyV2(value)
}
