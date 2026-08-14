export const runtimeContractArtifacts = api => [[
  'runtime-creation-v1.vectors.json',
  {
    invalid: [{
      code: 'runtime.binding_unavailable',
      name: 'owner-mismatch',
      spec: {
        ...api.runtimeInput,
        hostBindings: {
          ...api.runtimeInput.hostBindings,
          moduleResolver: {
            ...api.runtimeInput.hostBindings.moduleResolver,
            ownerId: 'other-owner'
          }
        }
      }
    }],
    schemaVersion: 1,
    valid: [{
      configurationDigest: api.generationOne.configurationDigest,
      generation: 1,
      hostBindingsDigest: api.generationOne.hostBindingsDigest,
      name: 'initial-admission',
      principal: api.generationOne.principal,
      spec: api.runtimeInput
    }, {
      configurationDigest: api.generationTwo.configurationDigest,
      generation: 2,
      hostBindingsDigest: api.generationTwo.hostBindingsDigest,
      name: 'restart-generation',
      principal: api.generationTwo.principal,
      spec: api.runtimeInput
    }]
  }
], [
  'invocation-snapshot-v1.vectors.json',
  {
    invalid: [{
      name: 'duplicate-object-key',
      snapshot: {
        direction: 'argument',
        root: {
          entries: [{ key: 'same', value: { kind: 'scalar', value: 1 } }, {
            key: 'same',
            value: { kind: 'scalar', value: 2 }
          }],
          kind: 'object'
        },
        schemaVersion: 1
      }
    }, {
      name: 'result-callback-binding',
      snapshot: {
        direction: 'result',
        root: {
          bindingId: 'callback-result',
          bindingType: 'callback',
          generation: 1,
          kind: 'binding'
        },
        schemaVersion: 1
      }
    }],
    schemaVersion: 1,
    vectors: [{
      name: 'argument-with-binary-and-callback',
      snapshot: api.normalizeInvocationSnapshotEnvelopeV1({
        direction: 'argument',
        root: {
          entries: [{
            key: 'body',
            value: {
              bindingId: 'binary-1',
              byteLength: 3,
              kind: 'binary',
              sha256: api.testDigest('abc')
            }
          }, {
            key: 'callback',
            value: {
              bindingId: 'callback-1',
              bindingType: 'callback',
              generation: 3,
              kind: 'binding'
            }
          }],
          kind: 'object'
        },
        schemaVersion: 1
      })
    }, {
      name: 'result-with-resource',
      snapshot: api.normalizeInvocationSnapshotEnvelopeV1({
        direction: 'result',
        root: {
          bindingId: 'resource-1',
          bindingType: 'resource',
          generation: 3,
          kind: 'binding'
        },
        schemaVersion: 1
      })
    }]
  }
], [
  'engine-gate-v1.vectors.json',
  {
    decisions: [
      api.normalizeEngineGateDecisionV1({ action: 'allow' }),
      api.normalizeEngineGateDecisionV1({ action: 'deny', reasonCode: 'host-denied' })
    ],
    requests: [api.normalizeEngineGateRequestMetadataV1({
      codeKind: 'strings',
      metadataSupport: {
        callsite: 'unavailable',
        entryDetail: 'unavailable',
        origin: 'unavailable',
        source: 'available'
      },
      operation: 'runtime.code.generate.strings',
      requestId: 'engine-request-1',
      runtime: {
        generation: 3,
        policyDigest: api.testDigest('policy'),
        processId: 'process-1'
      },
      schemaVersion: 1,
      sourceBytes: 3,
      sourceSha256: api.testDigest('source')
    })],
    schemaVersion: 1
  }
], [
  'observer-contract-v1.vectors.json',
  {
    events: [
      api.normalizeRuntimeObserverEventV1({
        event: 'script.compiled',
        generation: 3,
        observedAt: 4.5,
        payload: {
          scriptId: 'script-1',
          sourceBytes: 3,
          sourceSha256: api.testDigest('source')
        },
        schemaVersion: 1,
        sequence: 1
      }),
      api.normalizeRuntimeObserverEventV1({
        event: 'runtime.terminated',
        generation: 3,
        observedAt: 8,
        payload: { reason: 'completed' },
        schemaVersion: 1,
        sequence: 2
      })
    ],
    schemaVersion: 1
  }
]]
