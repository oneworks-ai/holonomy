// Guest facade forwarding only. Admission and lifecycle remain in the existing
// Kernel/NativeBridge owners; no Host object is published to Guest globals.
export const createNativeCapabilityBridge = (host, enqueueCallback) => {
  let nextCancellation = 0
  return {
    ...(enqueueCallback == null ? {} : { enqueueCallback }),
    invokeSync: request => host.capabilityInvokeSync(request),
    invokeImmediate: request => host.capabilityInvokeImmediate(request),
    async invoke(request, signal, hostInput) {
      const cancellationId = signal == null ? '' : `desktop-abort-${++nextCancellation}`
      const abort = () => host.capabilityAbort(cancellationId)
      signal?.add(abort)
      try {
        return await host.capabilityInvoke(
          request,
          cancellationId,
          signal?.readAborted() === true,
          hostInput?.networkRequestBodyBase64
        )
      } finally {
        signal?.remove(abort)
      }
    },
    releaseResource: id => host.capabilityRelease(id),
    subscribeResource(bindingId, listener) {
      const subscriptionId = host.capabilitySubscribe(bindingId, listener)
      return () => host.capabilityUnsubscribe(subscriptionId)
    }
  }
}
