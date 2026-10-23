/* eslint-disable max-lines -- Native v86 Backend composes one HoloUV environment and its bridges. */
import { V86CapabilityBrokerV1 } from '../../../../backends/v86/host/capability.mjs'
import { V86FuseBridgeV1 } from '../../../../backends/v86/host/fuse.mjs'
import { LinuxFilesystemCapabilityBridgeV1 } from '../../../../packages/capabilities/fs/src/kernel/linux-filesystem-bridge.ts'
import { normalizeProcessProfileV1 } from '../../../../packages/capabilities/process/src/host/profile.mjs'
import { LinuxProcessExecutionCapabilityBridgeV1 } from '../../../../packages/capabilities/process/src/kernel/process-supervisor-exec-bridge.ts'
import { HoloUvEnvironmentRuntimeV1 } from '../../../../packages/holouv/src/index.ts'

import { NativeV86ProcessNetworkBrokerV1 } from './process-v86-network-broker.mjs'
import { NativeV86SerialPumpV1, createNativeV86EnvironmentFactoryV1 } from './process-v86-transport.mjs'

export { NativeProcessBackendRegistryV1 } from './process-backend-registry.mjs'

const BACKEND_ID = 'experimental.v86-v1'
const MIB = 1024 * 1024
const invalid = () => {
  throw new TypeError('Invalid native v86 Process Backend')
}
const exact = (value, keys) => {
  if (
    value == null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))
  ) return invalid()
  return value
}
export const NATIVE_V86_PROCESS_DESCRIPTOR_V1 = Object.freeze({
  backendId: BACKEND_ID,
  binaryFormats: Object.freeze(['linux-x86-32']),
  environmentScopes: Object.freeze(['processTree']),
  family: 'virtual-machine',
  features: Object.freeze({
    filesystemBridge: true,
    networkBridge: true,
    pty: false,
    shell: true,
    signals: true,
    snapshots: false,
    synchronousSpawn: false
  }),
  platforms: Object.freeze(['desktop']),
  stability: 'experimental',
  version: 1
})

export const normalizeNativeV86ConfigurationV1 = value => {
  const input = exact(value, ['artifacts', 'memoryBytes', 'requiredKernelCapabilities', 'supervisor'])
  const artifacts = exact(input.artifacts, ['bios', 'initialState', 'initrd', 'kernel', 'wasm'])
  const artifact = entry => {
    const item = exact(entry, ['artifactId', 'sha256'])
    if (
      !/^[A-Za-z0-9][\w.-]{0,127}$/u.test(item.artifactId) ||
      typeof item.sha256 !== 'string' || !/^[a-f\d]{64}$/u.test(item.sha256)
    ) return invalid()
    return Object.freeze({ artifactId: item.artifactId, sha256: item.sha256 })
  }
  const supervisor = exact(input.supervisor, ['execGateTimeoutMs', 'protocolVersion'])
  const memoryBytes = input.memoryBytes
  if (
    !Number.isSafeInteger(memoryBytes) || memoryBytes < 64 * MIB || memoryBytes > 512 * MIB ||
    (memoryBytes & (memoryBytes - 1)) !== 0 || supervisor.protocolVersion !== 1 ||
    !Number.isSafeInteger(supervisor.execGateTimeoutMs) ||
    supervisor.execGateTimeoutMs < 1 || supervisor.execGateTimeoutMs > 120_000 ||
    artifacts.initialState != null || !Array.isArray(input.requiredKernelCapabilities) ||
    input.requiredKernelCapabilities.length < 1 || input.requiredKernelCapabilities.length > 2 ||
    !input.requiredKernelCapabilities.includes('process') ||
    new Set(input.requiredKernelCapabilities).size !== input.requiredKernelCapabilities.length ||
    input.requiredKernelCapabilities.some(value => !['process', 'fuse'].includes(value))
  ) {
    return invalid()
  }
  return Object.freeze({
    artifacts: Object.freeze({
      bios: artifact(artifacts.bios),
      kernel: artifact(artifacts.kernel),
      initrd: artifact(artifacts.initrd),
      wasm: artifact(artifacts.wasm)
    }),
    memoryBytes,
    requiredKernelCapabilities: Object.freeze([...input.requiredKernelCapabilities]),
    supervisor: Object.freeze({ execGateTimeoutMs: supervisor.execGateTimeoutMs, protocolVersion: 1 })
  })
}

export const normalizeNativeV86ExecutableV1 = value => {
  const input = exact(value, ['kind', 'path'])
  const path = input.path
  if (
    input.kind !== 'guestPath' || typeof path !== 'string' || path.length > 4096 ||
    path.includes('\0') || !/^\/(?:bin|sbin|usr\/bin|usr\/sbin)\//u.test(path) ||
    path.split('/').slice(1).some(component => component === '' || component === '.' || component === '..')
  ) {
    return invalid()
  }
  return Object.freeze({ kind: 'guestPath', path })
}

export const normalizeNativeV86ProfileV1 = (value, registry) => normalizeProcessProfileV1(value, registry, 'desktop')

export const createNativeV86ProcessBackendV1 = (command, pumpOptions, capabilityDomains = []) => {
  const capability = new V86CapabilityBrokerV1(capabilityDomains)
  const selectedDomains = Object.freeze([...capabilityDomains])
  let networkBroker
  const pump = new NativeV86SerialPumpV1(command, {
    ...pumpOptions,
    handleNetworkEvent: (event, request, deliver) => {
      if (networkBroker == null) return invalid()
      return networkBroker.handle(event, request, deliver)
    }
  })
  const execution = new LinuxProcessExecutionCapabilityBridgeV1()
  const filesystem = new LinuxFilesystemCapabilityBridgeV1()
  let releaseResource
  const fuse = new V86FuseBridgeV1(input => filesystem.dispatch(input), {
    releaseFileHandle: token => releaseResource?.(token)
  })
  const factory = createNativeV86EnvironmentFactoryV1(pump, {
    handleCapabilityRequest: input => capability.handle(input),
    handleFilesystemRequest: input => fuse.handle(input),
    handleNetworkAttribution(input) {
      if (networkBroker == null || input.policy?.network?.access !== 'restricted') return invalid()
    },
    onEnvironmentClose: environmentId => {
      fuse.releaseEnvironment(environmentId)
      networkBroker?.closeEnvironment(environmentId)
    },
    async authorizeExecution(input) {
      const target = input.executables.find(candidate =>
        candidate.executable.kind === 'guestPath' && candidate.executable.path === input.path &&
        candidate.shell !== true
      )
      if (target == null) return invalid()
      await execution.authorize(Object.freeze({
        argv: input.argv,
        callerExecutableId: input.callerExecutableId,
        cwd: input.cwd,
        environmentId: input.environmentId,
        executableId: target.executableId,
        linuxPid: input.linuxPid,
        parentLinuxPid: input.parentLinuxPid,
        path: input.path,
        policy: input.policy,
        processId: input.processId,
        processResourceId: input.processResourceId,
        processStartTimeTicks: input.processStartTimeTicks,
        rootLinuxPid: input.rootLinuxPid,
        scope: input.scope
      }))
    }
  })
  const runtime = new HoloUvEnvironmentRuntimeV1(factory)
  return Object.freeze({
    attachNetwork(port) {
      if (networkBroker != null || port == null) return invalid()
      networkBroker = new NativeV86ProcessNetworkBrokerV1(port)
    },
    bindKernel(invokeFromSource, release) {
      if (typeof release !== 'function') return invalid()
      releaseResource = release
      execution.bind(invokeFromSource)
      filesystem.bind(invokeFromSource)
      capability.bind(invokeFromSource)
      networkBroker?.bind(invokeFromSource)
    },
    closeGeneration(generation) {
      capability.closeGeneration(generation)
      networkBroker?.closeGeneration()
      return runtime.closeGeneration(generation)
    },
    descriptor: NATIVE_V86_PROCESS_DESCRIPTOR_V1,
    normalizeConfiguration: normalizeNativeV86ConfigurationV1,
    normalizeExecutable: normalizeNativeV86ExecutableV1,
    poll: () => pump.pump(),
    resolveNetwork(input) {
      if (networkBroker == null) return invalid()
      return networkBroker.resolveNetwork(input)
    },
    prepareLaunch(input) {
      if (
        input.policy?.access !== 'sandboxed' || input.policy.mounts.length > 1 ||
        input.policy.mounts.some(mount => mount.guestPath !== '/workspace') ||
        input.policy.mounts.length > 0 && !input.configuration.requiredKernelCapabilities.includes('fuse') ||
        input.policy.network.access !== 'none' &&
          (input.policy.network.access !== 'restricted' || networkBroker == null)
      ) return invalid()
      return Object.freeze({
        args: Object.freeze([...input.runtimeArgs]),
        configuration: input.configuration,
        cwd: '/',
        envScope: input.environmentScope,
        executable: input.executable,
        executableId: input.executableId,
        executables: input.executables,
        generation: input.generation,
        policy: input.policy
      })
    },
    spawn(launch, options, sink) {
      // Finish all fallible request construction before acquiring the lease.
      // An asynchronous open/spawn failure is closed by the Host port's terminal.
      const request = Object.freeze({
        args: launch.args,
        cwd: launch.cwd,
        env: options.env,
        executable: launch.executable,
        executableId: launch.executableId,
        processResourceId: options.processResourceId,
        stdio: options.stdio
      })
      const lease = runtime.acquire({
        configuration: launch.configuration,
        executables: launch.executables,
        generation: launch.generation,
        policy: launch.policy,
        scope: launch.envScope
      }, options.processResourceId)
      return {
        lease,
        request,
        sink
      }
    },
    validateProfile(profile) {
      if (
        profile.executables.length === 0 ||
        profile.environment.capabilityBridge.domains.length !== selectedDomains.length ||
        profile.environment.capabilityBridge.domains.some(domain => !selectedDomains.includes(domain)) ||
        profile.executables.some(item => item.executable.kind !== 'guestPath')
      ) return invalid()
    }
  })
}
