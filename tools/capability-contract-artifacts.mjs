import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
// eslint-disable-next-line antfu/no-import-dist
import {
  ANDROID_JAVET_ENGINE_PROBE_V1,
  CAPABILITY_DEFINITION_REGISTRY_V1,
  CAPABILITY_ERROR_MAP_V1,
  CAPABILITY_MACHINE_SCHEMA_ARTIFACTS_V1,
  DEFAULT_SANDBOX_POLICY_V2,
  DEVICE_OPERATIONS_V1,
  FACADE_DELIVERY_REGISTRY_V1,
  INVOCATION_SNAPSHOT_CAPABILITY_V1_SCHEMA,
  OPERATION_REGISTRY_V1,
  OPERATION_SCHEMA_OWNER_REGISTRY_V1,
  admitRuntimeCreationV1,
  bindInvocationResource,
  buildNetworkInvocationSnapshotV1,
  canonicalDigest,
  canonicalVirtualPath,
  canonicalizeFilesystemResource,
  canonicalizeNetworkResource,
  canonicalizeOpaqueHandleResource,
  canonicalizeProgramExecutableResource,
  canonicalizeShellExecutableResource,
  canonicalizeSystemInformationFieldResource,
  compileDeviceProviderDescriptorV1,
  compileHostSystemProjectionV1,
  compileRuntimeContextEnvelopeV1,
  compileSandboxPolicyV2,
  normalizeDeviceSummaryV1,
  normalizeEngineGateDecisionV1,
  normalizeEngineGateRequestMetadataV1,
  normalizeEngineHookCapabilityProbeV1,
  normalizeInvocationSnapshotEnvelopeV1,
  normalizeNetworkRedirectInvocationV1,
  normalizeResolvedResourceChallengeV1,
  normalizeRuntimeObserverEventV1,
  selectCapabilityBranchV1
} from '../dist/capability-runtime/index.js'
import { CAPABILITY_VECTOR_LIMITS, policyVectors } from './capability-contract-base-artifacts.mjs'
import {
  deviceSummaryInput,
  digestInput,
  restrictedPolicyInput,
  systemProjectionInput
} from './capability-contract-fixtures.mjs'
import { platformContractArtifacts } from './capability-contract-platform-artifacts.mjs'
import { processBackendContractArtifacts } from './capability-contract-process-backend-artifacts.mjs'
import { canonicalResourceVectors, resourceResolutionVectors } from './capability-contract-resource-artifacts.mjs'
import { runtimeContractArtifacts } from './capability-contract-runtime-artifacts.mjs'
import {
  androidDeviceDescriptorInput,
  capabilitySelectionInput,
  deviceDescriptorInput,
  runtimeCreationInput
} from './capability-contract-runtime-fixtures.mjs'
import { operationContractVectors } from './capability-operation-contract-artifacts.mjs'

const testDigest = label => canonicalDigest(digestInput(label))
const resourceApi = Object.freeze({
  bindInvocationResource,
  canonicalizeFilesystemResource,
  canonicalizeNetworkResource,
  canonicalizeOpaqueHandleResource,
  canonicalizeProgramExecutableResource,
  canonicalizeShellExecutableResource,
  canonicalizeSystemInformationFieldResource,
  normalizeResolvedResourceChallengeV1
})

const engineProbe = root =>
  normalizeEngineHookCapabilityProbeV1(JSON.parse(execFileSync(
    process.execPath,
    [resolve(root, 'tools/probe-node-engine-capabilities.mjs')],
    { encoding: 'utf8' }
  )))

export const capabilityContractArtifacts = root => {
  const selectionInput = capabilitySelectionInput(
    testDigest('policy'),
    CAPABILITY_VECTOR_LIMITS.filesystem,
    CAPABILITY_VECTOR_LIMITS.network
  )
  const context = compileRuntimeContextEnvelopeV1({ guest: { application: 'example' }, schemaVersion: 1 })
  const runtimeInput = runtimeCreationInput(DEFAULT_SANDBOX_POLICY_V2)
  const resolveBinding = reference => Object.freeze({ id: reference.bindingId })
  const generationOne = admitRuntimeCreationV1(runtimeInput, {
    expectedOwnerId: 'host-owner',
    generation: 1,
    processId: 'process-vector',
    resolveBinding
  })
  const generationTwo = admitRuntimeCreationV1(runtimeInput, {
    expectedOwnerId: 'host-owner',
    generation: 2,
    processId: 'process-vector',
    resolveBinding
  })
  return new Map([
    ...Object.entries(CAPABILITY_MACHINE_SCHEMA_ARTIFACTS_V1),
    ['operation-registry-v1.json', OPERATION_REGISTRY_V1],
    ['operation-schema-owners-v1.json', OPERATION_SCHEMA_OWNER_REGISTRY_V1],
    [
      'operation-contract-v1.vectors.json',
      operationContractVectors({
        buildNetworkInvocationSnapshotV1,
        normalizeNetworkRedirectInvocationV1
      })
    ],
    ['facade-delivery-registry-v1.json', FACADE_DELIVERY_REGISTRY_V1],
    ['capability-definition-registry-v1.json', CAPABILITY_DEFINITION_REGISTRY_V1],
    ['capability-error-map-v1.json', CAPABILITY_ERROR_MAP_V1],
    [
      'sandbox-policy-v2.vectors.json',
      policyVectors({
        compileSandboxPolicyV2,
        defaultPolicy: DEFAULT_SANDBOX_POLICY_V2,
        restrictedPolicyInput
      })
    ],
    ['canonical-resource-v1.vectors.json', canonicalResourceVectors(resourceApi, testDigest)],
    ['resource-resolution-v1.vectors.json', resourceResolutionVectors(resourceApi, testDigest)],
    ['host-system-projection-v1.vectors.json', {
      schemaVersion: 1,
      vectors: [{
        input: systemProjectionInput,
        name: 'configured-projection',
        normalized: compileHostSystemProjectionV1(systemProjectionInput)
      }, {
        input: { fields: {}, schemaVersion: 1 },
        name: 'default-unavailable',
        normalized: { fields: {}, schemaVersion: 1 }
      }]
    }],
    ...platformContractArtifacts({
      androidDeviceDescriptorInput,
      canonicalVirtualPath,
      compileDeviceProviderDescriptorV1,
      deviceDescriptorInput,
      deviceOperations: DEVICE_OPERATIONS_V1,
      deviceSummaryInput,
      normalizeDeviceSummaryV1
    }),
    ['capability-selection-v1.vectors.json', {
      schemaVersion: 1,
      vectors: [{
        ...selectionInput,
        name: 'filesystem-narrow-prefix',
        selected: selectCapabilityBranchV1(
          selectionInput.requirement,
          selectionInput.available,
          selectionInput.context
        )
      }]
    }],
    ...processBackendContractArtifacts(),
    ['runtime-context-v1.vectors.json', {
      schemaVersion: 1,
      vectors: [{
        context,
        digest: canonicalDigest(['runtimeContext', context]),
        name: 'separate-projections'
      }]
    }],
    ...runtimeContractArtifacts({
      generationOne,
      generationTwo,
      runtimeInput,
      testDigest,
      normalizeEngineGateDecisionV1,
      normalizeEngineGateRequestMetadataV1,
      normalizeInvocationSnapshotEnvelopeV1,
      normalizeRuntimeObserverEventV1
    }),
    ['invocation-snapshot-capability-v1.schema.json', INVOCATION_SNAPSHOT_CAPABILITY_V1_SCHEMA],
    ['android-engine-hook-capability-v1.json', ANDROID_JAVET_ENGINE_PROBE_V1],
    ['node-engine-hook-capability-v1.json', engineProbe(root)]
  ])
}
