import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { CapabilityRuntimeInvocationKernelV1, admitRuntimeCreationV1 } from 'holonomy/capability-runtime'
import { NodeFilesystemProviderV1 } from '../../adapters/node/src/capability-fs-provider.mjs'
import { NodeV86FilesystemBrokerV1 } from '../../adapters/node/src/capability-process-v86-filesystem-broker.mjs'
import { V86FuseBridgeV1 } from '../../adapters/node/src/capability-process-v86-fuse.mjs'
import { capabilityRuntimeSession } from '../../adapters/node/test/capability-runtime-fixture.mjs'

const processPolicy = Object.freeze({
  access: 'sandboxed',
  environment: Object.freeze({ allowedNames: Object.freeze([]), maxValueBytes: 1024 }),
  executables: Object.freeze([{ argumentBytes: 4096, executableId: 'v86-real-fuse' }]),
  limits: Object.freeze({
    maxConcurrentProcesses: 2,
    maxExecutionTimeMs: 60_000,
    maxOpenPipes: 6,
    maxProcessTreeDepth: 1,
    maxStderrBytes: 64 * 1024,
    maxStdinBytes: 64 * 1024,
    maxStdoutBytes: 64 * 1024,
    maxTotalProcesses: 4,
    maxWritableRootfsBytes: 64 * 1024
  }),
  mounts: Object.freeze([{
    guestPath: '/workspace',
    rights: Object.freeze(['read', 'write']),
    rootId: 'workspace'
  }]),
  network: Object.freeze({ access: 'none' }),
  shell: Object.freeze({ access: 'none' })
})

export const createV86FuseBrokerProbeV1 = async hostPath => {
  await writeFile(path.join(hostPath, 'input.txt'), 'HOST_TO_GUEST')
  const raw = capabilityRuntimeSession({
    entryUrl: 'app+local://workspace/main.mjs',
    hostPath,
    moduleRootUrl: 'app+local://workspace/',
    source: 'export {}'
  }).capabilityRuntime
  const fsBinding = raw.runtimeCreation.hostBindings.providerBindings.find(item => item.module === 'host.fs')
  const spec = {
    configuration: raw.runtimeCreation.configuration,
    hostBindings: {
      ...raw.runtimeCreation.hostBindings,
      providerBindings: [fsBinding]
    }
  }
  const provider = new NodeFilesystemProviderV1(raw.providerConfiguration.filesystemRoots)
  const events = []
  const middleware = Object.freeze({
    registrations: Object.freeze([Object.freeze({
      execution: 'async',
      layer: 'application',
      matcher: Object.freeze({ source: Object.freeze({ kind: 'linuxProcess' }) }),
      middleware: async (context, next) => {
        events.push(Object.freeze({
          executableId: context.source.executableId,
          linuxPid: context.source.linuxPid,
          operation: context.operation,
          path: context.resource.requested.semanticId,
          syntheticProcessId: context.source.syntheticProcessId
        }))
        return await next()
      },
      registrationId: 'v86-fuse-probe'
    })]),
    schemaVersion: 1
  })
  const resolved = new Map([
    [spec.hostBindings.engineGate.bindingId, {}],
    [spec.hostBindings.initialMiddlewareSet.bindingId, middleware],
    [spec.hostBindings.moduleResolver.bindingId, {}],
    [fsBinding.providerId, provider]
  ])
  const admitted = admitRuntimeCreationV1(spec, {
    expectedOwnerId: raw.ownerId,
    generation: 1,
    processId: raw.processId,
    resolveBinding: reference => resolved.get(reference.bindingId)
  })
  const kernel = new CapabilityRuntimeInvocationKernelV1({
    admitted,
    engine: 'node-v8-v86-probe',
    networkProvider: 'host.network',
    requestPrefix: 'v86-fuse',
    target: 'node'
  })
  const broker = new NodeV86FilesystemBrokerV1().bind(input => kernel.invokeFromSource(input))
  const fuse = new V86FuseBridgeV1(input => broker.dispatch(input))
  return Object.freeze({
    close: () => kernel.close(),
    events,
    handleFilesystemRequest: input => fuse.handle(input),
    policy: processPolicy,
    readFile: filePath => readFile(path.join(hostPath, filePath.slice('/workspace/'.length)))
  })
}
