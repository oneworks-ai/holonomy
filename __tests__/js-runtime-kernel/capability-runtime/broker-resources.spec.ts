import { describe, expect, it } from 'vitest'

import {
  CapabilityInvocationBrokerV1,
  buildNetworkInvocationSnapshotV1,
  normalizeNetworkRedirectInvocationV1
} from '../../../src/capability-runtime/index.js'
import type { SandboxPolicyV2 } from '../../../src/capability-runtime/index.js'
import { creation, fsResource, middleware, policyV2, provider, snapshot } from './broker-fixtures.js'

const networkPolicy = (): SandboxPolicyV2 => ({
  ...policyV2(),
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
      maxResponseBodyBytes: 8192,
      maxUrlBytes: 4096,
      socketTimeoutMs: 5000
    },
    requestBodyInspection: { access: 'none' }
  }
})

const responseFacade = (bindingId: string) => ({
  binding: { bindingId, generation: 1 },
  resourceType: 'network.response'
})

describe('capability invocation broker resource lifecycle', () => {
  it('publishes generation-bound resources and reuses inherited authority without Host middleware', () => {
    let hostCalls = 0
    let resourceClosed = 0
    let providerCalls = 0
    const fs = provider('host.fs', 'sync', 'unused', (context, authority) => {
      providerCalls += 1
      if (context.member === 'openSync') {
        return authority.complete(snapshot({ binding: 'opaque', fd: 7 }, 'result'), [{
          bindingId: 'fd-7',
          close: () => {
            resourceClosed += 1
          },
          resource: context.resource.requested,
          resourceType: 'filesystem.file-handle'
        }])
      }
      return authority.complete(snapshot({}, 'result'))
    })
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }, {
        registrations: [middleware('host', (_context, next) => {
          hostCalls += 1
          return next()
        }, 'sync')],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    const opened = broker.invokeSync({
      arguments: snapshot({ flag: 'r', path: 'holo-fs://workspace/demo.txt' }, 'argument'),
      invocationMode: 'sync',
      member: 'openSync',
      module: 'node:fs',
      requestId: 'open-resource',
      resource: fsResource()
    })
    expect(opened.value).toEqual({ binding: 'opaque', fd: 7 })
    expect(broker.resource('fd-7').semanticResourceDigest).toBe(fsResource().semanticResourceDigest)

    broker.invokeSync({
      arguments: snapshot({ fd: 7 }, 'argument'),
      inheritedBindingId: 'fd-7',
      invocationMode: 'sync',
      member: 'closeSync',
      module: 'node:fs',
      requestId: 'close-resource',
      resource: fsResource()
    })
    expect({ hostCalls, providerCalls }).toEqual({ hostCalls: 1, providerCalls: 2 })
    expect(resourceClosed).toBe(1)
    expect(() => broker.resource('fd-7')).toThrow(expect.objectContaining({ code: 'runtime.generation_stale' }))
  })

  it('intercepts Network requests and redirects while system-only Response continuations reuse authority', async () => {
    const hostOperations: string[] = []
    const providerOperations: string[] = []
    const authorityDigests: string[][] = []
    const closedBindings: string[] = []
    const response = (bindingId: string, context: Parameters<NonNullable<Parameters<typeof provider>[3]>>[0]) => ({
      bindingId,
      close: () => {
        closedBindings.push(bindingId)
      },
      resource: context.resource.requested,
      resourceType: 'network.response'
    })
    const network = provider('host.network.mock', 'sync', 'unused', (context, authority) => {
      providerOperations.push(context.operation)
      authorityDigests.push(authority.bindings.map(binding => binding.authorityDigest))
      if (context.member === 'fetch') {
        return authority.complete(
          snapshot(responseFacade('response-1'), 'result'),
          [response('response-1', context)]
        )
      }
      if (context.member === 'followRedirect') {
        return authority.complete(snapshot({}, 'result'))
      }
      if (context.member === 'Response.metadata') {
        return authority.complete(snapshot(context.providerData, 'result'))
      }
      if (context.member === 'Response.clone') {
        return authority.complete(
          snapshot(responseFacade('response-2'), 'result'),
          [response('response-2', context)]
        )
      }
      return authority.complete(snapshot('redirected', 'result'))
    })
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.network.mock': network }, {
        registrations: [middleware('network-host', (context, next) => {
          hostOperations.push(context.operation)
          return next()
        })],
        schemaVersion: 1
      }, networkPolicy()),
      engine: 'node-vm',
      target: 'node'
    })
    const initial = buildNetworkInvocationSnapshotV1({
      headers: [['accept', 'text/plain']],
      hop: 0,
      label: 'api.example/start',
      logicalRequestId: 'logical-request-1',
      method: 'GET',
      url: 'https://api.example/start'
    })
    const redirected = buildNetworkInvocationSnapshotV1({
      headers: [['accept', 'text/plain']],
      hop: 1,
      label: 'api.example/final',
      logicalRequestId: 'logical-request-1',
      method: 'GET',
      url: 'https://api.example/final'
    })
    const redirect = normalizeNetworkRedirectInvocationV1({
      bodyReplay: 'none',
      fromHop: 0,
      fromRequest: initial,
      logicalRequestId: 'logical-request-1',
      methodRewritten: false,
      status: 302,
      toHop: 1,
      toRequest: redirected
    })

    await broker.invoke({
      arguments: snapshot(initial, 'argument'),
      invocationMode: 'promise',
      member: 'fetch',
      module: 'web:fetch',
      preferredProviderModule: 'host.network.mock',
      requestId: 'network-request',
      resource: initial.resource
    })
    await broker.invoke({
      arguments: snapshot(redirect, 'argument'),
      inheritedBindingId: 'response-1',
      invocationMode: 'promise',
      member: 'followRedirect',
      module: 'web:fetch',
      requestId: 'network-redirect',
      resource: redirected.resource
    })
    const metadata = {
      generation: 1,
      headers: [],
      hop: 1,
      logicalRequestId: 'logical-request-1',
      redirected: true,
      responseId: 'response-1',
      source: 'mock',
      status: 200,
      statusText: 'OK',
      url: 'https://api.example/final'
    }
    expect(
      broker.invokeSync({
        arguments: snapshot({}, 'argument'),
        inheritedBindingId: 'response-1',
        invocationMode: 'sync',
        member: 'Response.metadata',
        module: 'web:fetch',
        providerData: snapshot(metadata, 'argument'),
        requestId: 'network-metadata',
        resource: broker.resource('response-1', 'network.response')
      }).value
    ).toEqual(metadata)
    expect(
      (await broker.invoke({
        arguments: snapshot({}, 'argument'),
        inheritedBindingId: 'response-1',
        invocationMode: 'promise',
        member: 'Response.text',
        module: 'web:fetch',
        requestId: 'network-body',
        resource: broker.resource('response-1', 'network.response')
      })).value
    ).toBe('redirected')
    expect(
      broker.invokeSync({
        arguments: snapshot({}, 'argument'),
        inheritedBindingId: 'response-1',
        invocationMode: 'sync',
        member: 'Response.clone',
        module: 'web:fetch',
        requestId: 'network-clone',
        resource: broker.resource('response-1', 'network.response')
      }).value
    ).toEqual(responseFacade('response-2'))

    expect(hostOperations).toEqual(['network.fetch.request', 'network.fetch.redirect'])
    expect(providerOperations).toEqual([
      'network.fetch.request',
      'network.fetch.redirect',
      'network.response.metadata.read',
      'network.response.body.read',
      'network.response.body.read'
    ])
    expect(authorityDigests.every(value => value.join() === authorityDigests[0]!.join())).toBe(true)
    expect(broker.resource('response-2', 'network.response').kind).toBe('network')

    broker.releaseResource('response-1')
    broker.releaseResource('response-2')
    expect(closedBindings).toEqual(['response-1', 'response-2'])
  })
})
