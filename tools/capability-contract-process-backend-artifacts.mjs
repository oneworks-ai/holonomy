// eslint-disable-next-line antfu/no-import-dist
import {
  PROCESS_BACKEND_PROBE_CAPABILITIES_V1,
  normalizeProcessBackendDescriptorV1,
  normalizeProcessBackendProbeEvidenceV1
} from '../dist/capability-runtime/index.js'

const observation = capability =>
  capability === 'installation'
    ? { capability, provenance: 'behavioralProbe', status: 'passed' }
    : { capability, provenance: 'profileStaticUnsupported', reasonCode: 'fixture.not_run', status: 'notRun' }

export const processBackendContractArtifacts = () => [
  ['process-backend-v1.vectors.json', {
    schemaVersion: 1,
    vectors: [{
      name: 'native-darwin-seatbelt',
      normalized: normalizeProcessBackendDescriptorV1({
        backendId: 'native.darwin-seatbelt-v1',
        binaryFormats: ['host-native'],
        environmentScopes: ['processTree'],
        family: 'native',
        features: {
          filesystemBridge: false,
          networkBridge: false,
          pty: false,
          shell: true,
          signals: true,
          snapshots: false,
          synchronousSpawn: true
        },
        platforms: ['node', 'desktop'],
        stability: 'stable',
        version: 1
      })
    }]
  }],
  ['process-backend-probe-v1.vectors.json', {
    schemaVersion: 1,
    vectors: [{
      name: 'contract-fixture',
      normalized: normalizeProcessBackendProbeEvidenceV1({
        artifact: {
          artifactKind: 'source',
          artifactVersion: '1.0.0',
          license: 'MIT',
          sourceRevision: 'fixture'
        },
        backendId: 'fixture.experimental-v1',
        host: {
          architecture: 'arm64',
          engine: 'node-v8',
          engineVersion: 'fixture',
          platform: 'darwin',
          runtimeVersion: 'fixture'
        },
        metrics: { bootDurationMs: 0 },
        observations: PROCESS_BACKEND_PROBE_CAPABILITIES_V1.map(observation),
        schemaVersion: 1
      })
    }]
  }]
]
