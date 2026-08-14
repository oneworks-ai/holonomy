export const PROCESS_BACKEND_PROBE_CAPABILITIES_V1 = Object.freeze(
  [
    'installation',
    'boot',
    'workload',
    'stdio',
    'exit',
    'filesystem',
    'network',
    'processTree',
    'runtime',
    'snapshots',
    'androidPackaging'
  ] as const
)

export type ProcessBackendProbeCapabilityV1 = typeof PROCESS_BACKEND_PROBE_CAPABILITIES_V1[number]
export type ProcessBackendProbeStatusV1 = 'failed' | 'notRun' | 'passed' | 'unsupported'
export type ProcessBackendProbeProvenanceV1 =
  | 'behavioralProbe'
  | 'profileStaticUnsupported'
  | 'upstreamContract'

export interface ProcessBackendProbeObservationV1 {
  readonly capability: ProcessBackendProbeCapabilityV1
  readonly provenance: ProcessBackendProbeProvenanceV1
  readonly reasonCode?: string
  readonly status: ProcessBackendProbeStatusV1
}

export interface ProcessBackendProbeEvidenceV1 {
  readonly artifact: Readonly<{
    artifactKind: 'npm' | 'source' | 'wasm'
    artifactVersion: string
    integritySha256?: string
    license: string
    sourceRevision?: string
  }>
  readonly backendId: string
  readonly host: Readonly<{
    architecture: 'arm64' | 'x64' | 'x86'
    engine: 'javet-v8' | 'node-v8'
    engineVersion: string
    platform: 'android' | 'darwin' | 'linux' | 'win32'
    runtimeVersion: string
  }>
  readonly metrics: Readonly<{
    bootDurationMs?: number
    peakRssBytes?: number
    workloadDurationMs?: number
  }>
  readonly observations: readonly ProcessBackendProbeObservationV1[]
  readonly schemaVersion: 1
}

const invalid = (): never => {
  throw new TypeError('Process Backend probe evidence is invalid')
}

const record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !keys.includes(key))) return invalid()
  return input
}

const identifier = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9][\w.+-]{0,127}$/u.test(value) ? value : invalid()

const optionalIdentifier = (value: unknown): string | undefined => value == null ? undefined : identifier(value)

const metric = (value: unknown, maximum: number): number | undefined => {
  if (value == null) return undefined
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum
    ? value as number
    : invalid()
}

const observation = (value: unknown): ProcessBackendProbeObservationV1 => {
  const input = record(value, ['capability', 'provenance', 'reasonCode', 'status'])
  const capability = identifier(input.capability) as ProcessBackendProbeCapabilityV1
  const provenance = identifier(input.provenance) as ProcessBackendProbeProvenanceV1
  const status = identifier(input.status) as ProcessBackendProbeStatusV1
  if (
    !PROCESS_BACKEND_PROBE_CAPABILITIES_V1.includes(capability) ||
    !['behavioralProbe', 'profileStaticUnsupported', 'upstreamContract'].includes(provenance) ||
    !['failed', 'notRun', 'passed', 'unsupported'].includes(status) ||
    (['passed', 'failed'].includes(status) && provenance !== 'behavioralProbe') ||
    (status === 'passed' && input.reasonCode != null) ||
    (status !== 'passed' && input.reasonCode == null)
  ) return invalid()
  return Object.freeze({
    capability,
    provenance,
    ...(status === 'passed' ? {} : { reasonCode: identifier(input.reasonCode) }),
    status
  })
}

export const normalizeProcessBackendProbeEvidenceV1 = (value: unknown): ProcessBackendProbeEvidenceV1 => {
  const input = record(value, ['artifact', 'backendId', 'host', 'metrics', 'observations', 'schemaVersion'])
  const artifact = record(input.artifact, [
    'artifactKind',
    'artifactVersion',
    'integritySha256',
    'license',
    'sourceRevision'
  ])
  const host = record(input.host, ['architecture', 'engine', 'engineVersion', 'platform', 'runtimeVersion'])
  const metrics = record(input.metrics, ['bootDurationMs', 'peakRssBytes', 'workloadDurationMs'])
  if (
    !Array.isArray(input.observations) || input.observations.length !== PROCESS_BACKEND_PROBE_CAPABILITIES_V1.length
  ) {
    return invalid()
  }
  const observations = input.observations.map(observation).sort((left, right) =>
    PROCESS_BACKEND_PROBE_CAPABILITIES_V1.indexOf(left.capability) -
    PROCESS_BACKEND_PROBE_CAPABILITIES_V1.indexOf(right.capability)
  )
  if (observations.some((item, index) => item.capability !== PROCESS_BACKEND_PROBE_CAPABILITIES_V1[index])) {
    return invalid()
  }
  const artifactKind = identifier(artifact.artifactKind)
  const architecture = identifier(host.architecture)
  const engine = identifier(host.engine)
  const platform = identifier(host.platform)
  if (
    !['npm', 'source', 'wasm'].includes(artifactKind) ||
    !['arm64', 'x64', 'x86'].includes(architecture) ||
    !['javet-v8', 'node-v8'].includes(engine) ||
    !['android', 'darwin', 'linux', 'win32'].includes(platform) ||
    input.schemaVersion !== 1
  ) return invalid()
  const integritySha256 = optionalIdentifier(artifact.integritySha256)
  if (integritySha256 != null && !/^[0-9a-f]{64}$/u.test(integritySha256)) return invalid()
  return Object.freeze({
    artifact: Object.freeze({
      artifactKind: artifactKind as ProcessBackendProbeEvidenceV1['artifact']['artifactKind'],
      artifactVersion: identifier(artifact.artifactVersion),
      ...(integritySha256 == null ? {} : { integritySha256 }),
      license: identifier(artifact.license),
      ...(artifact.sourceRevision == null ? {} : { sourceRevision: identifier(artifact.sourceRevision) })
    }),
    backendId: identifier(input.backendId),
    host: Object.freeze({
      architecture: architecture as ProcessBackendProbeEvidenceV1['host']['architecture'],
      engine: engine as ProcessBackendProbeEvidenceV1['host']['engine'],
      engineVersion: identifier(host.engineVersion),
      platform: platform as ProcessBackendProbeEvidenceV1['host']['platform'],
      runtimeVersion: identifier(host.runtimeVersion)
    }),
    metrics: Object.freeze({
      ...(metrics.bootDurationMs == null ? {} : { bootDurationMs: metric(metrics.bootDurationMs, 86_400_000) }),
      ...(metrics.peakRssBytes == null ? {} : { peakRssBytes: metric(metrics.peakRssBytes, 137_438_953_472) }),
      ...(metrics.workloadDurationMs == null
        ? {}
        : { workloadDurationMs: metric(metrics.workloadDurationMs, 86_400_000) })
    }),
    observations: Object.freeze(observations),
    schemaVersion: 1
  })
}
