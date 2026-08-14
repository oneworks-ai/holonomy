export const canonicalResourceVectors = (api, testDigest) => {
  const program = api.canonicalizeProgramExecutableResource({
    argvDigest: testDigest('argv'),
    environmentNamesDigest: testDigest('environment'),
    environmentScope: 'processTree',
    executableId: 'git',
    label: 'git status',
    stdioDigest: testDigest('stdio')
  })
  const filesystem = api.canonicalizeFilesystemResource(
    'holo-fs://workspace/src/main.js',
    'main.js'
  )
  return {
    schemaVersion: 1,
    vectors: {
      filesystem,
      invocation: api.bindInvocationResource({
        authorityDigest: testDigest('authority'),
        capabilityBindingDigest: testDigest('capability'),
        generation: 7,
        operation: 'filesystem.file.read',
        processId: 'process-vector',
        requestId: 'request-vector',
        semanticResourceDigest: filesystem.semanticResourceDigest
      }),
      program,
      shell: api.canonicalizeShellExecutableResource({
        commandDigest: testDigest('command'),
        environmentNamesDigest: testDigest('environment'),
        environmentScope: 'runtime',
        label: 'git status',
        shellExecutableId: 'shell',
        stdioDigest: testDigest('stdio')
      }),
      systemField: api.canonicalizeSystemInformationFieldResource('os.arch', 'Architecture')
    }
  }
}

export const resourceResolutionVectors = (api, testDigest) => {
  const requested = api.canonicalizeFilesystemResource('holo-fs://workspace/link', 'link')
  const resolved = api.canonicalizeFilesystemResource('holo-fs://workspace/target', 'target')
  const network = api.canonicalizeNetworkResource(
    'https://api.example/profile',
    'GET',
    null,
    'Profile'
  )
  const opaque = api.canonicalizeOpaqueHandleResource({
    bridgeIdentityDigest: testDigest('bridge'),
    generation: 3,
    label: 'Handle',
    resourceType: 'fs.file',
    rightsDigest: testDigest('rights')
  })
  const binding = kind => ({
    bindingId: `evidence-${kind}`,
    evidenceDigest: testDigest(kind),
    kind
  })
  const challenge = (reason, evidence, before, after, id) => ({
    challengeId: id,
    evidence,
    parentRequestId: 'request-resolution',
    reason,
    requested: before,
    resolved: after,
    schemaVersion: 1,
    sequence: 1
  })
  const valid = [
    challenge('networkAddress', binding('networkAddress'), network, network, 'network'),
    challenge('filesystemTarget', binding('filesystemTarget'), requested, resolved, 'filesystem'),
    challenge('opaqueRebind', binding('opaqueIdentity'), opaque, opaque, 'opaque')
  ].map(value => api.normalizeResolvedResourceChallengeV1(value))
  const admin = api.canonicalizeNetworkResource(
    'https://api.example/admin',
    'GET',
    null,
    'Admin'
  )
  const other = api.canonicalizeFilesystemResource('holo-fs://other/secret', 'secret')
  return {
    invalid: [{
      expectedCode: 'runtime.configuration_invalid',
      name: 'filesystem-cross-root',
      value: challenge(
        'filesystemTarget',
        binding('filesystemTarget'),
        requested,
        api.canonicalizeFilesystemResource('holo-fs://other/target', 'target'),
        'filesystem-cross-root'
      )
    }, {
      expectedCode: 'runtime.configuration_invalid',
      name: 'network-semantic-tamper',
      value: challenge(
        'networkAddress',
        binding('networkAddress'),
        network,
        api.canonicalizeNetworkResource('https://api.example/admin', 'GET', null, 'Admin'),
        'network-tamper'
      )
    }, {
      expectedCode: 'runtime.configuration_invalid',
      name: 'opaque-generation-tamper',
      value: challenge(
        'opaqueRebind',
        binding('opaqueIdentity'),
        opaque,
        { ...opaque, generation: 4 },
        'opaque-tamper'
      )
    }, {
      expectedCode: 'runtime.configuration_invalid',
      name: 'network-forged-digest',
      value: challenge(
        'networkAddress',
        binding('networkAddress'),
        network,
        {
          ...admin,
          semanticId: network.semanticId,
          semanticResourceDigest: network.semanticResourceDigest
        },
        'network-forged-digest'
      )
    }, {
      expectedCode: 'runtime.configuration_invalid',
      name: 'filesystem-forged-root',
      value: challenge(
        'filesystemTarget',
        binding('filesystemTarget'),
        requested,
        {
          ...other,
          rootId: requested.rootId,
          semanticId: requested.semanticId,
          semanticResourceDigest: requested.semanticResourceDigest
        },
        'filesystem-forged-root'
      )
    }],
    schemaVersion: 1,
    valid
  }
}
