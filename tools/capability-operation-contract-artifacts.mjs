export const operationContractVectors = api => {
  const networkRequest = api.buildNetworkInvocationSnapshotV1({
    headers: [['accept', 'application/json']],
    hop: 0,
    label: 'api.example/profile',
    logicalRequestId: 'request-1',
    method: 'GET',
    url: 'https://api.example/profile?token=secret'
  })
  const redirectedRequest = api.buildNetworkInvocationSnapshotV1({
    headers: [['accept', 'application/json']],
    hop: 1,
    label: 'api.example/next',
    logicalRequestId: 'request-1',
    method: 'GET',
    url: 'https://api.example/next?token=secret'
  })
  return {
    filesystem: {
      invalid: [{
        args: {
          options: { encoding: 'utf8', signal: { bindingId: 'abort', generation: 1 } },
          path: 'holo-fs://workspace/file.txt'
        },
        name: 'sync-read-rejects-signal',
        schemaId: 'FsReadFileSyncArgsV1'
      }, {
        args: [{ kind: 'file', name: 'x' }],
        name: 'readdir-name-result-rejects-dirents',
        schemaId: 'FsReaddirNamesResultV1'
      }],
      valid: [{
        args: { path: 'holo-fs://workspace/file.txt' },
        name: 'read-default-buffer',
        resultSchemaId: 'RuntimeBufferV1',
        schemaId: 'FsReadFileSyncBufferArgsV1'
      }, {
        args: {
          options: { encoding: 'utf8' },
          path: 'holo-fs://workspace/file.txt'
        },
        name: 'read-explicit-string',
        resultSchemaId: 'string',
        schemaId: 'FsReadFileSyncStringArgsV1'
      }, {
        args: {
          options: { withFileTypes: true },
          path: 'holo-fs://workspace/'
        },
        name: 'readdir-dirents',
        resultSchemaId: 'FsReaddirDirentsResultV1',
        schemaId: 'FsReaddirDirentsArgsV1'
      }, {
        args: {
          options: { recursive: true },
          path: 'holo-fs://workspace/new'
        },
        name: 'mkdir-recursive',
        resultSchemaId: 'FsMkdirRecursiveResultV1',
        schemaId: 'FsMkdirRecursiveArgsV1'
      }]
    },
    network: {
      invalid: [{
        name: 'none-body-rejects-length',
        schemaId: 'NetworkInvocationSnapshotV1',
        value: { ...networkRequest, body: { kind: 'none', length: 1 } }
      }, {
        name: 'redirect-rejects-missing-authority-fields',
        schemaId: 'NetworkRedirectInvocationV1',
        value: { fromHop: 0, logicalRequestId: 'request-1', toHop: 1 }
      }, {
        expectedCode: 'runtime.configuration_invalid',
        name: 'request-rejects-mutated-header-view',
        schemaId: 'NetworkInvocationSnapshotV1',
        semantic: true,
        value: {
          ...networkRequest,
          headers: [{ index: 0, name: 'accept', value: 'text/plain', visibility: 'visible' }]
        }
      }, {
        expectedCode: 'runtime.configuration_invalid',
        name: 'request-rejects-mutated-query-view',
        schemaId: 'NetworkInvocationSnapshotV1',
        semantic: true,
        value: {
          ...networkRequest,
          query: [{ index: 0, key: 'page', value: '2', visibility: 'visible' }]
        }
      }, {
        expectedCode: 'runtime.configuration_invalid',
        name: 'redirect-rejects-307-method-rewrite',
        schemaId: 'NetworkRedirectInvocationV1',
        semantic: true,
        value: {
          bodyReplay: 'none',
          fromHop: 0,
          fromRequest: networkRequest,
          logicalRequestId: 'request-1',
          methodRewritten: true,
          status: 307,
          toHop: 1,
          toRequest: { ...redirectedRequest, method: 'POST' }
        }
      }, {
        expectedCode: 'runtime.configuration_invalid',
        name: 'redirect-rejects-body-replay-without-body',
        schemaId: 'NetworkRedirectInvocationV1',
        semantic: true,
        value: {
          bodyReplay: 'same-buffered-body',
          fromHop: 0,
          fromRequest: networkRequest,
          logicalRequestId: 'request-1',
          methodRewritten: false,
          status: 307,
          toHop: 1,
          toRequest: redirectedRequest
        }
      }],
      valid: [{
        name: 'request-metadata',
        normalized: networkRequest,
        schemaId: 'NetworkInvocationSnapshotV1'
      }, {
        name: 'redirect-full-binding',
        normalized: api.normalizeNetworkRedirectInvocationV1({
          bodyReplay: 'none',
          fromHop: 0,
          fromRequest: networkRequest,
          logicalRequestId: 'request-1',
          methodRewritten: false,
          status: 302,
          toHop: 1,
          toRequest: redirectedRequest
        }),
        schemaId: 'NetworkRedirectInvocationV1'
      }]
    },
    process: {
      invalid: [{
        name: 'program-rejects-args-in-options',
        schemaId: 'ProcessProgramSpawnArgsV1',
        value: { environmentScope: 'processTree', executableId: 'git', options: { args: ['status'] } }
      }, {
        name: 'exec-file-rejects-stdio',
        schemaId: 'ProcessExecFileArgsV1',
        value: {
          environmentScope: 'processTree',
          executableId: 'git',
          options: { stdio: ['pipe', 'pipe', 'pipe'] }
        }
      }, {
        name: 'program-rejects-unknown-environment-scope',
        schemaId: 'ProcessProgramSpawnArgsV1',
        value: { environmentScope: 'host', executableId: 'git' }
      }],
      valid: [{
        name: 'program-minimal',
        schemaId: 'ProcessProgramSpawnArgsV1',
        value: { environmentScope: 'processTree', executableId: 'git' }
      }, {
        name: 'program-argv',
        schemaId: 'ProcessProgramSpawnArgsV1',
        value: { args: ['status'], environmentScope: 'runtime', executableId: 'git' }
      }, {
        name: 'shell-spawn',
        schemaId: 'ProcessShellSpawnArgsV1',
        value: {
          command: 'printf ok',
          environmentScope: 'processTree',
          options: { shell: true, shellExecutableId: 'sh' }
        }
      }, {
        name: 'exec-encoding',
        schemaId: 'ProcessExecArgsV1',
        value: {
          command: 'printf ok',
          environmentScope: 'processTree',
          options: { encoding: 'utf8', shellExecutableId: 'sh' }
        }
      }]
    },
    schemaVersion: 1
  }
}
