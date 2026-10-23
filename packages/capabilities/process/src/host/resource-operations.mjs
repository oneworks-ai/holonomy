import { assertProcessAuthorityV1 } from './authority.mjs'
import { processInputData, processSignal } from './support.mjs'

const MAX_PENDING_STDIN_CALLBACKS = 256

const stdioFacade = (state, inheritedBindingId) => {
  if (inheritedBindingId.endsWith('-stdout')) return state.facade.stdout
  if (inheritedBindingId.endsWith('-stderr')) return state.facade.stderr
  return state.facade.stdin
}

const stdinCallbackId = (context, CapabilityInvocationError) => {
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

const registerStdinCallback = (context, state, CapabilityInvocationError) => {
  const callbackId = stdinCallbackId(context, CapabilityInvocationError)
  if (callbackId != null) {
    if (state.pendingStdinCallbacks.has(callbackId)) {
      throw new CapabilityInvocationError('argument.invalid', context.operation)
    }
    if (state.pendingStdinCallbacks.size >= MAX_PENDING_STDIN_CALLBACKS) {
      throw new CapabilityInvocationError('resource.handle_limit', context.operation)
    }
    state.pendingStdinCallbacks.add(callbackId)
  }
  return callbackId
}

export const invokeProcessResourceV1 = ({ authority, close, context, contracts, policy, port, state }) => {
  const { CapabilityInvocationError, trustedInvocationValueFromJsonV1 } = contracts
  const signal = context.operation === 'process.signal.send'
    ? processSignal(context.arguments, CapabilityInvocationError)
    : undefined
  assertProcessAuthorityV1(context, authority, state.executableId, signal, CapabilityInvocationError)
  if (signal != null) {
    if (port.descriptor.features.signals !== true) {
      throw new CapabilityInvocationError('provider.unavailable', context.operation)
    }
    close(state, signal)
    return authority.complete(trustedInvocationValueFromJsonV1(true, 'result'))
  }
  if (context.operation === 'process.stdin.write') {
    const data = processInputData(context.arguments, port, CapabilityInvocationError)
    if (data.byteLength > policy.limits.maxStdinBytes - state.stdinBytes) {
      throw new CapabilityInvocationError('resource.byte_limit', context.operation)
    }
    if (state.stdinEnded || state.stdinClosed || state.facade.stdin == null) {
      throw new CapabilityInvocationError('resource.stale', context.operation)
    }
    const callbackId = registerStdinCallback(context, state, CapabilityInvocationError)
    state.stdinBytes += data.byteLength
    let accepted
    try {
      accepted = state.handle.writeStdin(data, callbackId)
    } catch (error) {
      state.stdinBytes -= data.byteLength
      state.pendingStdinCallbacks.delete(callbackId)
      if (error instanceof CapabilityInvocationError && error.code === 'resource.handle_limit') throw error
      throw new CapabilityInvocationError('resource.stale', context.operation)
    }
    return authority.complete(trustedInvocationValueFromJsonV1(accepted, 'result'))
  }
  const inherited = context.resource.inheritedBindingId ?? ''
  if (context.operation === 'process.stdin.end') {
    const callbackId = registerStdinCallback(context, state, CapabilityInvocationError)
    if (state.stdinEnded) {
      queueMicrotask(() => {
        if (callbackId != null && state.pendingStdinCallbacks.delete(callbackId)) {
          state.stdinEvents.emit({ callbackId, error: null, event: 'callback' })
        }
      })
      return authority.complete(trustedInvocationValueFromJsonV1(state.facade.stdin, 'result'))
    }
    if (state.stdinClosed || state.facade.stdin == null) {
      state.pendingStdinCallbacks.delete(callbackId)
      throw new CapabilityInvocationError('resource.stale', context.operation)
    }
    state.stdinEnded = true
    try {
      state.handle.endStdin(callbackId)
    } catch (error) {
      state.pendingStdinCallbacks.delete(callbackId)
      if (error instanceof CapabilityInvocationError && error.code === 'resource.handle_limit') {
        state.stdinEnded = false
        throw error
      }
      throw new CapabilityInvocationError('resource.stale', context.operation)
    }
    return authority.complete(trustedInvocationValueFromJsonV1(state.facade.stdin, 'result'))
  }
  if (context.operation === 'process.stdio.destroy') {
    const index = inherited.endsWith('-stdout') ? 1 : inherited.endsWith('-stderr') ? 2 : 0
    if (index === 0) state.stdinEnded = true
    state.handle.destroyStdio(index)
    return authority.complete(trustedInvocationValueFromJsonV1(stdioFacade(state, inherited), 'result'))
  }
  if (context.operation === 'process.stdio.pause' || context.operation === 'process.stdio.resume') {
    const index = inherited.endsWith('-stdout') ? 1 : 2
    const events = index === 1 ? state.stdoutEvents : state.stderrEvents
    if (context.operation.endsWith('pause')) {
      events.pause()
    } else {
      events.resume()
    }
    return authority.complete(trustedInvocationValueFromJsonV1(stdioFacade(state, inherited), 'result'))
  }
  if (context.operation === 'process.resource.close') {
    close(state, 'SIGKILL')
    return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
  }
  throw new CapabilityInvocationError('provider.unavailable', context.operation)
}
