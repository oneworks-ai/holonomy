import { expect } from 'vitest'

import { encodeBase64 } from '../../../packages/runtime/src/node-compat/encoding.js'
import {
  CapabilityRuntimeInvocationKernelV1,
  buildNetworkInvocationSnapshotV1,
  compileSandboxPolicyV2,
  selectCapabilityBranchV1
} from '../../../src/capability-runtime/index.js'
import type { HoloMiddlewareV1 } from '../../../src/capability-runtime/index.js'
import { creation, middleware, provider, snapshot } from './broker-fixtures.js'

export const body = new TextEncoder().encode('PRIVATE_REQUEST_BODY')
export const request = JSON.stringify({
  module: 'web:fetch',
  member: 'fetch',
  mode: 'promise',
  arguments: buildNetworkInvocationSnapshotV1({
    body,
    hop: 0,
    label: 'post',
    logicalRequestId: 'logical-1',
    method: 'POST',
    url: 'https://api.example/'
  })
})
export const hostInput = { networkRequestBodyBase64: encodeBase64(body, false) }

export const create = (intercept: HoloMiddlewareV1, installed = true, timeoutMs?: number, socketTimeoutMs = 5000) => {
  let io = 0
  const network = provider('host.network.mock', 'sync', {}, (context, authority) => {
    expect(context.hostBindings).toBeUndefined()
    io++
    const bindingId = `response-${context.requestId}`
    return authority.complete(
      snapshot({ binding: { bindingId, generation: 1 }, resourceType: 'network.response' }, 'result'),
      [{
        bindingId,
        resource: context.resource.requested,
        resourceType: 'network.response',
        close() {}
      }]
    )
  })
  const policy = compileSandboxPolicyV2({
    schemaVersion: 2,
    network: {
      access: 'mockOnly',
      allowedOrigins: ['https://api.example'],
      allowedSchemes: ['https'],
      allowPrivateNetwork: false,
      limits: {
        maxChunkBytes: 1024,
        maxConcurrentConnections: 2,
        maxHeaderBytes: 4096,
        maxHeaders: 32,
        maxRedirects: 4,
        maxRequestBodyBytes: 4096,
        maxResponseBodyBytes: 4096,
        maxUrlBytes: 4096,
        socketTimeoutMs
      },
      requestBodyInspection: { access: 'bounded', maxBytes: 64, maxReadsPerRuntime: 2 }
    }
  }).policy
  const admitted = creation({ 'host.network.mock': network }, {
    schemaVersion: 1,
    registrations: [middleware('body', intercept, 'async', timeoutMs)]
  }, policy)
  const constraints = { maxReadBytes: 32, maxReads: 1 }
  const selection = selectCapabilityBranchV1(
    {
      anyOf: [{
        branchId: 'body-reader',
        allOf: [{
          name: 'host.network.request-body.read',
          version: 1,
          constraints
        }]
      }]
    },
    [{ name: 'host.network.request-body.read', version: 1, constraints }],
    {
      generation: admitted.generation,
      principal: admitted.principal,
      processId: admitted.processId,
      policyDigest: compileSandboxPolicyV2(policy).digest
    }
  )!
  const kernel = new CapabilityRuntimeInvocationKernelV1({
    admitted,
    engine: 'embedded-v8',
    target: 'desktop',
    requestPrefix: 'test',
    networkProvider: 'host.network.mock',
    ...(installed ? { networkRequestBodyReader: selection } : {})
  })
  return { kernel, admitted, selection, io: () => io }
}
