import { createCapabilityNetworkHooksV1 } from '@holonomyjs/capability-network'
import { createCapabilityModuleOverridesV1 } from '@holonomyjs/runtime/kernel'

const encodeSourceInput = input =>
  JSON.stringify({
    ...input,
    ...(input?.bytes instanceof Uint8Array ? { bytes: [...input.bytes] } : {})
  })

const decodeSourceTerminal = source => {
  const terminal = JSON.parse(source)
  if (terminal.ok !== true) {
    const error = new Error(terminal.error?.message ?? 'Capability invocation failed')
    Object.defineProperty(error, 'code', {
      enumerable: true,
      value: terminal.error?.code ?? 'runtime.internal'
    })
    if (Number.isInteger(terminal.error?.errno)) {
      Object.defineProperty(error, 'errno', {
        enumerable: true,
        value: terminal.error.errno
      })
    }
    if (typeof terminal.error?.operation === 'string') {
      Object.defineProperty(error, 'operation', {
        enumerable: true,
        value: terminal.error.operation
      })
    }
    throw error
  }
  if (terminal.result?.kind === 'bytes' && Array.isArray(terminal.result.bytes)) {
    return new Uint8Array(terminal.result.bytes)
  }
  return terminal.result?.value
}

export const createAndroidCapabilityRuntime = (host, platformConfiguration = {}) => {
  const source = host.capabilityConfiguration()
  if (source == null) return null
  const envelope = JSON.parse(source)
  const session = envelope.session
  const creation = session.runtimeCreation
  const processProfile = session.providerConfiguration?.processProfile
  const processFields = ['process.cwd', 'process.env', 'process.execPath', 'process.pid']
  const processEnabled = processFields.every(field =>
    creation.configuration.systemProjection.fields[field] != null &&
    creation.configuration.sandboxPolicy.systemInformation.fields[field] != null
  )
  const guestConfiguration = Object.freeze({
    context: creation.configuration.context.guest ?? null,
    ...(processProfile == null ? {} : { processEnvironment: processProfile.environment }),
    ...(processProfile?.defaultShellExecutableId == null
      ? {}
      : { processShellExecutableId: processProfile.defaultShellExecutableId }),
    ...(processEnabled
      ? {
        process: platformConfiguration.process,
        processControl: platformConfiguration.processControl,
        stdio: platformConfiguration.stdio
      }
      : {})
  })
  const bridge = Object.freeze({
    invoke: async (json, signal) => host.capabilityInvoke(json, signal?.readAborted?.() === true),
    invokeImmediate: json => host.capabilityInvokeImmediate(json),
    invokeSync: json => host.capabilityInvokeSync(json),
    releaseResource: bindingId => host.capabilityReleaseResource(bindingId),
    subscribeResource: (bindingId, listener) => {
      const subscriptionId = host.capabilitySubscribeResource(bindingId, listener)
      return typeof subscriptionId === 'string'
        ? () => host.capabilityUnsubscribeResource(subscriptionId)
        : () => undefined
    }
  })
  return Object.freeze({
    close: () => host.capabilityClose(),
    configuration: guestConfiguration,
    network: createCapabilityNetworkHooksV1(bridge),
    linuxFilesystem: Object.freeze({
      dispatch: input =>
        Promise.resolve(
          host.capabilityInvokeFromSource('linuxFilesystem', encodeSourceInput(input))
        ).then(decodeSourceTerminal)
    }),
    linuxCapability: Object.freeze({
      invoke: input =>
        Promise.resolve(
          host.capabilityInvokeFromSource('linuxCapability', encodeSourceInput(input))
        ).then(decodeSourceTerminal)
    }),
    linuxProcessExecution: Object.freeze({
      authorize: input =>
        Promise.resolve(
          host.capabilityInvokeFromSource('linuxProcessExecution', encodeSourceInput(input))
        ).then(decodeSourceTerminal)
    }),
    linuxProcessNetwork: Object.freeze({
      authorize: input =>
        Promise.resolve(
          host.capabilityInvokeFromSource('linuxProcessNetwork', encodeSourceInput(input))
        ).then(decodeSourceTerminal)
    }),
    moduleOverrides: createCapabilityModuleOverridesV1(guestConfiguration, bridge)
  })
}
