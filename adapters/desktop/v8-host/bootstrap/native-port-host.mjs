import { NetworkMockRouter } from '../../../../packages/capabilities/network/src/web/network-mock-router.ts'
import { sha256Hex } from '../../../../packages/runtime/src/module-loader/sha256.ts'
import { RuntimeBuffer } from '../../../../packages/runtime/src/node-compat/buffer.ts'
import { NodeNetworkNativePort } from '../../../node/src/node-network-native-port.mjs'
import { drainNativeEventBatch } from './event-batch.mjs'

export const createNativePort = (network, policy, rules, storageDispatch) => {
  const authority = network == null ? undefined : {
    allowedOrigins: policy.allowedOrigins,
    allowedSchemes: policy.allowedSchemes,
    privateNetwork: policy.allowPrivateNetwork ? 'allow' : 'deny',
    limits: policy.limits
  }
  const capabilities = network == null
    ? []
    : [policy.access === 'restricted' ? 'host.network.http' : 'host.network.mock']
  const transport = network == null ? undefined : new NodeNetworkNativePort({ request: network.request }, {
    maxChunkBytes: policy.limits.maxChunkBytes
  })
  const router = network == null ? undefined : new NetworkMockRouter({
    authority,
    passthrough: transport,
    bodySha256: sha256Hex,
    bodySha256Chunks: chunks => sha256Hex(RuntimeBuffer.concat(chunks)),
    initialRules: rules ?? { mode: policy.access === 'restricted' ? 'passthrough' : 'failClosed', rules: [] },
    delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
    verifyRequest: network.verify
  })
  let queue = []
  let closed = false
  const storagePending = new Map()
  const emitEncoded = (callToken, channel, event) => {
    if (queue.length >= 4096) throw new Error('Native port event queue limit')
    queue.push({ callToken, channel, event })
  }
  const emit = (callToken, channel, event) => {
    emitEncoded(callToken, channel, {
      ...event,
      ...(event.binary == null
        ? {}
        : {
          binary: event.binary.map(item => ({
            handle: item.handle,
            base64: RuntimeBuffer.from(item.data).toString('base64')
          }))
        })
    })
  }
  const dispatchStorage = (request, context) => {
    const token = context.callToken
    const terminal = (value, binary) =>
      emitEncoded(token, 'call', {
        id: request.id,
        type: 'result',
        value,
        ...(binary == null ? {} : { binary })
      })
    if (closed || storageDispatch == null || storagePending.has(token)) {
      terminal({ ok: false, error: { code: closed ? 'storage.cancelled' : 'storage.authorization_denied' } })
      return
    }
    const controller = new AbortController()
    storagePending.set(token, controller)
    void Promise.resolve().then(() => storageDispatch(request, token, controller.signal)).then(output => {
      if (storagePending.get(token) !== controller) return
      storagePending.delete(token)
      terminal(output.value, output.binary)
    }).catch(() => {
      if (storagePending.get(token) !== controller) return
      storagePending.delete(token)
      terminal({ ok: false, error: { code: 'storage.internal' } })
    })
  }
  const drain = () => drainNativeEventBatch(queue)
  return {
    authority,
    capabilities,
    drain,
    command(json) {
      const input = JSON.parse(json)
      if (input.kind === 'dispatch') {
        const request = input.request
        const ctx = input.context
        if (request.module === 'host.storage') {
          dispatchStorage(request, ctx)
          return drain()
        }
        if (router == null) {
          emit(ctx.callToken, 'call', {
            id: request.id,
            type: 'error',
            error: { domain: 'runtime', code: 'permission_denied' }
          })
          return drain()
        }
        const references = new Map((ctx.resources ?? []).map(item => [item.reference.resource, item.reference]))
        const restore = value => {
          if (value == null || typeof value !== 'object') return value
          if (
            !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.resource === 'string' &&
            references.has(value.resource)
          ) return references.get(value.resource)
          if (Array.isArray(value)) return value.map(restore)
          return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, restore(value)]))
        }
        request.args = restore(request.args)
        if (request.binary) {
          request.binary = request.binary.map(item => ({
            handle: item.handle,
            data: RuntimeBuffer.from(item.base64, 'base64')
          }))
        }
        const context = { ...ctx, authority: { principal: 'desktop-runtime', capabilities } }
        try {
          const pending = router.dispatch(
            request,
            context,
            event => emit(ctx.callToken, 'call', event),
            event => emit(ctx.callToken, 'resource', event)
          )
          if (pending != null) {
            void Promise.resolve(pending).catch(() =>
              emit(ctx.callToken, 'call', { id: request.id, type: 'error', error: { code: 'internal' } })
            )
          }
        } catch {
          emit(ctx.callToken, 'call', { id: request.id, type: 'error', error: { code: 'internal' } })
        }
      } else if (input.kind === 'cancel') {
        const controller = storagePending.get(input.callToken)
        if (controller !== undefined) {
          storagePending.delete(input.callToken)
          controller.abort()
        } else router?.cancel(input.callToken)
      } else if (input.kind === 'close') router?.closeResource(input.ownerCallToken, input.providerToken)
      else if (input.kind === 'credits') router?.grantCredits(input.callToken, input.credits)
      else if (input.kind === 'dispose') {
        closed = true
        for (const controller of storagePending.values()) controller.abort()
        storagePending.clear()
        router?.dispose()
        queue = []
      } else throw new Error('Invalid network transport command')
      return drain()
    },
    close() {
      closed = true
      for (const controller of storagePending.values()) controller.abort()
      storagePending.clear()
      router?.dispose()
      queue = []
    }
  }
}
