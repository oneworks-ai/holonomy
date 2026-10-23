import type {
  CapabilityGuestBridgeV1,
  CapabilityGuestConfigurationV1
} from '@holonomyjs/runtime/kernel/guest-facade-support'
import {
  createCapabilityRequestV1,
  createCapabilitySyntheticBindingV1,
  readCapabilityTerminalV1
} from '@holonomyjs/runtime/kernel/guest-facade-support'
import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import { prepareChildProcessAbortSignalV1 } from './guest-child-process-abort.js'
import { createChildProcessResourceFactoryV1 } from './guest-child-process-resources.js'
import {
  childProcessRecordV1,
  collectChildProcessOutputV1,
  invalidChildProcessValueV1,
  optionalChildProcessCallbackV1,
  shellQuoteV1,
  snapshotChildProcessArgsV1,
  snapshotChildProcessOptionsV1
} from './guest-child-process-support.js'

export const createCapabilityChildProcessOverrideV1 = (
  bridge: CapabilityGuestBridgeV1,
  configuration: Pick<
    CapabilityGuestConfigurationV1,
    'processEnvironment' | 'processShellExecutableId' | 'processControl'
  >
) => {
  if (bridge.invokeImmediate == null) return undefined
  const immediate = (member: string, args: JsonValueV1, mode: 'callback' | 'sync' = 'callback') =>
    readCapabilityTerminalV1(
      bridge.invokeImmediate!(createCapabilityRequestV1('node:child_process', member, mode, args))
    )
  const sync = (member: string, args: JsonValueV1) =>
    readCapabilityTerminalV1(
      bridge.invokeSync(createCapabilityRequestV1('node:child_process', member, 'sync', args))
    )
  const processControl = configuration.processControl
  const child = createChildProcessResourceFactoryV1(
    bridge,
    processControl?.nextTick == null ? undefined : callback => processControl.nextTick?.(callback)
  )
  const spawn = (executableId: unknown, args?: unknown, options?: unknown) => {
    if (typeof executableId !== 'string') return invalidChildProcessValueV1('executableId must be a string')
    const actualArgs = Array.isArray(args) || args === undefined ? snapshotChildProcessArgsV1(args) : []
    const actualOptions = Array.isArray(args) || args === undefined ? options : args
    const shell = childProcessRecordV1(actualOptions ?? {}).shell === true
    const snapshot = snapshotChildProcessOptionsV1(actualOptions, shell, false, configuration.processEnvironment)
    const optionsSnapshot = snapshot.options as Record<string, JsonValueV1>
    if (shell && optionsSnapshot.shellExecutableId == null) {
      if (configuration.processShellExecutableId == null) {
        return invalidChildProcessValueV1('A controlled shell is unavailable')
      }
      optionsSnapshot.shellExecutableId = configuration.processShellExecutableId
    }
    const signal = prepareChildProcessAbortSignalV1(childProcessRecordV1(actualOptions ?? {}).signal)
    const resource = child(
      immediate(
        shell ? 'spawnShell' : 'spawn',
        shell
          ? {
            command: [executableId, ...actualArgs].map(shellQuoteV1).join(' '),
            environmentScope: snapshot.environmentScope,
            options: optionsSnapshot
          }
          : {
            args: actualArgs,
            environmentScope: snapshot.environmentScope,
            executableId,
            options: optionsSnapshot
          },
        'sync'
      ),
      signal
    ) as Record<string, unknown>
    return resource
  }
  const execFile = (executableId: unknown, args?: unknown, options?: unknown, done?: unknown) => {
    if (typeof executableId !== 'string') return invalidChildProcessValueV1('executableId must be a string')
    const actualArgs = Array.isArray(args) ? args : []
    const actualOptions = Array.isArray(args)
      ? typeof options === 'function' ? {} : options
      : typeof args === 'function' || args == null
      ? {}
      : args
    const callbackValue = done ??
      (typeof options === 'function' ? options : typeof args === 'function' ? args : undefined)
    const accepted = optionalChildProcessCallbackV1(callbackValue)
    const snapshot = snapshotChildProcessOptionsV1(actualOptions, false, true, configuration.processEnvironment)
    const signal = prepareChildProcessAbortSignalV1(childProcessRecordV1(actualOptions ?? {}).signal)
    const resource = child(
      immediate('execFile', {
        args: snapshotChildProcessArgsV1(actualArgs),
        environmentScope: snapshot.environmentScope,
        executableId,
        options: snapshot.options
      }),
      signal
    ) as Record<string, unknown>
    if (accepted != null) {
      collectChildProcessOutputV1(
        resource,
        childProcessRecordV1(actualOptions ?? {}).encoding,
        accepted
      )
    }
    return resource
  }
  const exec = (command: unknown, options?: unknown, done?: unknown) => {
    if (typeof command !== 'string' || command.length === 0) {
      return invalidChildProcessValueV1('Command must be a string')
    }
    const actualOptions = typeof options === 'function' || options == null ? {} : options
    const accepted = optionalChildProcessCallbackV1(typeof options === 'function' ? options : done)
    if (configuration.processShellExecutableId == null) {
      return invalidChildProcessValueV1('A controlled shell is unavailable')
    }
    const snapshot = snapshotChildProcessOptionsV1(actualOptions, false, true, configuration.processEnvironment)
    const optionsSnapshot = snapshot.options as Record<string, JsonValueV1>
    optionsSnapshot.shellExecutableId ??= configuration.processShellExecutableId
    const signal = prepareChildProcessAbortSignalV1(childProcessRecordV1(actualOptions).signal)
    const resource = child(
      immediate('exec', {
        command,
        environmentScope: snapshot.environmentScope,
        options: optionsSnapshot
      }),
      signal
    ) as Record<string, unknown>
    if (accepted != null) {
      collectChildProcessOutputV1(
        resource,
        childProcessRecordV1(actualOptions).encoding,
        accepted
      )
    }
    return resource
  }
  const spawnSync = (executableId: unknown, args?: unknown, options?: unknown) => {
    if (typeof executableId !== 'string') return invalidChildProcessValueV1('executableId must be a string')
    const actualArgs = Array.isArray(args) || args === undefined ? snapshotChildProcessArgsV1(args) : []
    const actualOptions = Array.isArray(args) || args === undefined ? options : args
    const snapshot = snapshotChildProcessOptionsV1(actualOptions, false, false, configuration.processEnvironment)
    return sync('spawnSync', {
      args: actualArgs,
      environmentScope: snapshot.environmentScope,
      executableId,
      options: snapshot.options
    })
  }
  const execFileSync = (executableId: unknown, args?: unknown, options?: unknown) => {
    if (typeof executableId !== 'string') return invalidChildProcessValueV1('executableId must be a string')
    const snapshot = snapshotChildProcessOptionsV1(
      Array.isArray(args) ? options : args,
      false,
      true,
      configuration.processEnvironment
    )
    return sync('execFileSync', {
      args: snapshotChildProcessArgsV1(Array.isArray(args) ? args : []),
      environmentScope: snapshot.environmentScope,
      executableId,
      options: snapshot.options
    })
  }
  const execSync = (command: unknown, options?: unknown) => {
    if (typeof command !== 'string' || command.length === 0) {
      return invalidChildProcessValueV1('Command must be a string')
    }
    if (configuration.processShellExecutableId == null) {
      return invalidChildProcessValueV1('A controlled shell is unavailable')
    }
    const snapshot = snapshotChildProcessOptionsV1(options, false, true, configuration.processEnvironment)
    const optionsSnapshot = snapshot.options as Record<string, JsonValueV1>
    optionsSnapshot.shellExecutableId ??= configuration.processShellExecutableId
    return sync('execSync', {
      command,
      environmentScope: snapshot.environmentScope,
      options: optionsSnapshot
    })
  }
  const namespace = Object.freeze({ exec, execFile, execFileSync, execSync, spawn, spawnSync })
  return createCapabilitySyntheticBindingV1(
    { ...namespace, default: namespace },
    [...Object.keys(namespace), 'default']
  )
}
