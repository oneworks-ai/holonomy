// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError, trustedInvocationValueFromJsonV1 } from '../../../dist/capability-runtime/index.js'

import { nodeError, processInputData, processSignal } from './capability-process-support.mjs'
import { assertNodeProcessAuthorityV1 } from './capability-provider-authority.mjs'

const stdioFacade = (state, inheritedBindingId) => {
  if (inheritedBindingId.endsWith('-stdout')) return state.facade.stdout
  if (inheritedBindingId.endsWith('-stderr')) return state.facade.stderr
  return state.facade.stdin
}

const stdinCallbackId = context => {
  if (context.providerData == null) return undefined
  const value = context.providerData
  if (
    typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== 1 || !Number.isSafeInteger(value.callbackId) || value.callbackId < 1
  ) throw new CapabilityInvocationError('argument.invalid', context.operation)
  if (context.operation !== 'process.stdin.write' && context.operation !== 'process.stdin.end') {
    throw new CapabilityInvocationError('argument.invalid', context.operation)
  }
  return value.callbackId
}

const stdinError = error =>
  nodeError(
    error?.code === 'ERR_INVALID_STATE' || error?.code === 'ERR_STREAM_WRITE_AFTER_END'
      ? 'ERR_INVALID_STATE'
      : 'EIO'
  )

const registerStdinCallback = (context, state) => {
  const callbackId = stdinCallbackId(context)
  if (callbackId != null) {
    if (state.pendingStdinCallbacks.has(callbackId)) {
      throw new CapabilityInvocationError('argument.invalid', context.operation)
    }
    state.pendingStdinCallbacks.add(callbackId)
  }
  return callbackId
}

const settleStdinCallback = (state, callbackId, error) => {
  if (callbackId == null || !state.pendingStdinCallbacks.delete(callbackId)) return
  state.stdinEvents.emit({ callbackId, error: error == null ? null : stdinError(error), event: 'callback' })
}

export const invokeNodeProcessResourceV1 = ({ authority, backend, close, context, policy, state }) => {
  const signal = context.operation === 'process.signal.send' ? processSignal(context.arguments) : undefined
  assertNodeProcessAuthorityV1(context, authority, state.executableId, signal)
  if (signal != null) {
    if (backend.descriptor.features.signals !== true) {
      throw new CapabilityInvocationError('provider.unavailable', context.operation)
    }
    close(state, signal)
    return authority.complete(trustedInvocationValueFromJsonV1(true, 'result'))
  }
  if (context.operation === 'process.stdin.write') {
    const data = processInputData(context.arguments)
    state.stdinBytes += data.byteLength
    if (state.stdinBytes > policy.limits.maxStdinBytes) {
      throw new CapabilityInvocationError('resource.byte_limit', context.operation)
    }
    if (state.stdinEnded || state.child.stdin == null || state.child.stdin.destroyed) {
      throw new CapabilityInvocationError('resource.stale', context.operation)
    }
    const callbackId = registerStdinCallback(context, state)
    try {
      const accepted = state.child.stdin.write(data, error => settleStdinCallback(state, callbackId, error))
      return authority.complete(trustedInvocationValueFromJsonV1(accepted, 'result'))
    } catch {
      state.pendingStdinCallbacks.delete(callbackId)
      throw new CapabilityInvocationError('resource.stale', context.operation)
    }
  }
  const inherited = context.resource.inheritedBindingId ?? ''
  if (context.operation === 'process.stdin.end') {
    const callbackId = registerStdinCallback(context, state)
    if (state.stdinEnded) {
      queueMicrotask(() => settleStdinCallback(state, callbackId, null))
      return authority.complete(trustedInvocationValueFromJsonV1(state.facade.stdin, 'result'))
    }
    if (state.child.stdin == null || state.child.stdin.destroyed) {
      state.pendingStdinCallbacks.delete(callbackId)
      throw new CapabilityInvocationError('resource.stale', context.operation)
    }
    state.stdinEnded = true
    try {
      state.child.stdin.end(error => settleStdinCallback(state, callbackId, error))
    } catch {
      state.pendingStdinCallbacks.delete(callbackId)
      throw new CapabilityInvocationError('resource.stale', context.operation)
    }
    return authority.complete(trustedInvocationValueFromJsonV1(state.facade.stdin, 'result'))
  }
  if (context.operation === 'process.stdio.destroy') {
    if (inherited.endsWith('-stdout')) state.child.stdout?.destroy()
    else if (inherited.endsWith('-stderr')) state.child.stderr?.destroy()
    else {
      state.stdinEnded = true
      state.child.stdin?.destroy()
    }
    return authority.complete(trustedInvocationValueFromJsonV1(stdioFacade(state, inherited), 'result'))
  }
  if (context.operation === 'process.stdio.pause' || context.operation === 'process.stdio.resume') {
    const events = inherited.endsWith('-stdout') ? state.stdoutEvents : state.stderrEvents
    if (context.operation.endsWith('pause')) events.pause()
    else events.resume()
    return authority.complete(trustedInvocationValueFromJsonV1(stdioFacade(state, inherited), 'result'))
  }
  if (context.operation === 'process.resource.close') {
    close(state, 'SIGKILL')
    return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
  }
  throw new CapabilityInvocationError('provider.unavailable', context.operation)
}
