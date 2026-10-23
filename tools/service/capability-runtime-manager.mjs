/* eslint-disable max-lines -- Native source selection extends the existing Service admission owner. */
import process from 'node:process'

import { NODE_PROCESS_BACKEND_REGISTRY_V1 } from '../../adapters/node/src/capability-process-backend.mjs'
import { normalizeNodeProcessBackendInstallationV1 } from '../../adapters/node/src/capability-process-v86-installation.mjs'
import { normalizeNodeProcessProfileV1 } from '../../adapters/node/src/capability-session.mjs'
import { assertNativeCapabilityPolicyDigestV1 } from './capability-runtime-admission-support.mjs'
import {
  admitCapabilityRuntimeRequestV1,
  normalizeCapabilityMiddlewareRegistryV1
} from './capability-runtime-admission.mjs'
import { createDefaultHostSystemProjectionV1 } from './capability-runtime-host-snapshots.mjs'
import {
  DEFAULT_RUNTIME_OBSERVER_HOST_CAPS,
  normalizeCapabilityObserverRegistryV1,
  selectNativeRuntimeObserverProfilesV1
} from './capability-runtime-observers.mjs'
import { prepareCapabilityRuntimeV1 } from './capability-runtime-preparation.mjs'
import { serviceError } from './errors.mjs'
import {
  normalizeNativeDiagnosticAuditInstallation,
  selectNativeDiagnosticAuditForPolicy
} from './native-diagnostic-audit-installation.mjs'
import {
  normalizeNativeDiagnosticSourceReaderInstallation,
  selectNativeDiagnosticSourceReaderForPolicy
} from './native-diagnostic-source-reader-installation.mjs'
import { normalizeServiceNativeObserverProfilesV1 } from './native-observer-profiles.mjs'

const requireProfileId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][\w.-]{0,127}$/u.test(value)) {
    throw new TypeError('Process profile id is invalid')
  }
  return value
}

const nativeDeviceAvailable = (policy, installation) =>
  Object.keys(policy.device.operations).length === 0 ||
  installation?.implementation === 'builtin.darwin-device-v1' &&
    process.platform === 'darwin' && process.arch === 'arm64'

const assertNativeObserverVersions = (request, selected) => {
  const binding = Object.getOwnPropertyDescriptor(request, 'nativeObserverBindingVersions')
  if (selected.length === 0) {
    if (binding != null) {
      throw serviceError('service.precondition_failed', 'Native Runtime Observer binding is invalid')
    }
    return
  }
  const versions = binding?.value
  if (versions == null || typeof versions !== 'object' || Array.isArray(versions)) {
    throw serviceError('service.precondition_failed', 'Native Runtime Observer binding is unavailable')
  }
  const prototype = Object.getPrototypeOf(versions)
  if (prototype !== Object.prototype && prototype !== null) {
    throw serviceError('service.precondition_failed', 'Native Runtime Observer binding is invalid')
  }
  const descriptors = Object.getOwnPropertyDescriptors(versions)
  const keys = Reflect.ownKeys(descriptors)
  if (
    keys.length !== selected.length ||
    keys.some(key => typeof key !== 'string') ||
    selected.some(profile =>
      descriptors[profile.id] == null || !Object.hasOwn(descriptors[profile.id], 'value') ||
      descriptors[profile.id].value !== profile.version
    )
  ) {
    throw serviceError('service.precondition_failed', 'Native Runtime Observer binding has changed')
  }
}

const nativeProcessProfile = (request, profiles, backends) => {
  const policy = request.sandboxPolicy.process
  if (policy.access === 'none') return undefined
  const profile = profiles.get(request.processProfileId)
  const descriptor = backends.get(profile?.backend.backendId)?.descriptor
  if (
    process.platform !== 'darwin' || policy.access !== 'sandboxed' ||
    profile?.backend.backendId !== 'native.darwin-seatbelt-v1' ||
    descriptor?.backendId !== profile.backend.backendId ||
    descriptor.family !== 'native' || !descriptor.platforms.includes('desktop') ||
    descriptor.features.synchronousSpawn !== true || descriptor.features.signals !== true ||
    descriptor.features.pty !== false || descriptor.features.snapshots !== false ||
    policy.network.access !== 'none' || policy.mounts.length !== 0 ||
    policy.limits.maxWritableRootfsBytes !== 0
  ) {
    throw serviceError('sandbox.capability_unsupported', 'Native Process Backend is unavailable')
  }
  return profile
}

export class ServiceCapabilityRuntimeManagerV1 {
  #middleware
  #stateDirectory
  #factories
  #engineGateAvailable
  #observerHostCaps
  #observers
  #processProfiles
  #processBackends
  #processBackendInstallations
  #sourceReaderHostCaps
  #nativeDiagnosticSourceReader
  #nativeDiagnosticAudit
  #nativeDeviceProvider
  #nativeObserverProfiles

  constructor(options = {}) {
    this.#middleware = normalizeCapabilityMiddlewareRegistryV1(options.middlewareRegistry)
    this.#stateDirectory = options.stateDirectory
    this.#engineGateAvailable = typeof options.engineGate === 'function'
    this.#observers = normalizeCapabilityObserverRegistryV1(options.observerRegistry)
    this.#observerHostCaps = Object.freeze({
      ...DEFAULT_RUNTIME_OBSERVER_HOST_CAPS,
      ...options.observerHostCaps
    })
    this.#sourceReaderHostCaps = Object.freeze({ maxReadBytes: 0, ...options.sourceReaderHostCaps })
    this.#nativeDiagnosticSourceReader = normalizeNativeDiagnosticSourceReaderInstallation(
      options.nativeDiagnosticSourceReader
    )
    this.#nativeDiagnosticAudit = normalizeNativeDiagnosticAuditInstallation(options.nativeDiagnosticAudit)
    this.#nativeDeviceProvider = options.nativeDeviceProvider
    this.#nativeObserverProfiles = normalizeServiceNativeObserverProfilesV1(options.nativeObserverProfiles)
    if (
      !Number.isSafeInteger(this.#sourceReaderHostCaps.maxReadBytes) ||
      this.#sourceReaderHostCaps.maxReadBytes < 0 || this.#sourceReaderHostCaps.maxReadBytes > 1024 * 1024 ||
      this.#sourceReaderHostCaps.maxReadBytes > 0 &&
        this.#sourceReaderHostCaps.capabilityName !== 'host.diagnostics.source.read'
    ) throw new TypeError('Engine source reader Host capability is invalid')
    this.#processBackends = options.processBackendRegistry ?? NODE_PROCESS_BACKEND_REGISTRY_V1
    this.#processBackendInstallations = new Map(
      [
        ...(options.processBackendInstallations instanceof Map
          ? options.processBackendInstallations.entries()
          : Object.entries(options.processBackendInstallations ?? {}))
      ].map(([id, installation]) => {
        const normalized = normalizeNodeProcessBackendInstallationV1(installation)
        if (normalized.backendId !== id || this.#processBackends.get(id) == null) {
          throw new TypeError('Process Backend installation is invalid')
        }
        return [id, normalized]
      })
    )
    this.#processProfiles = new Map(
      [
        ...(options.processProfiles instanceof Map
          ? options.processProfiles.entries()
          : Object.entries(options.processProfiles ?? {}))
      ].map(([id, profile]) => [
        requireProfileId(id),
        normalizeNodeProcessProfileV1(profile, this.#processBackends)
      ])
    )
    if (
      [...this.#processProfiles.values()].some(profile =>
        profile.backend.backendId === 'experimental.v86-v1' &&
        !this.#processBackendInstallations.has(profile.backend.backendId)
      )
    ) throw new TypeError('Process Backend installation is unavailable')
    this.#factories = Object.freeze({
      deviceSnapshot: options.deviceSnapshotFactory,
      systemProjection: options.systemProjectionFactory
    })
  }

  admit(value, expected) {
    const admitted = admitCapabilityRuntimeRequestV1(
      value,
      expected,
      this.#middleware,
      this.#processProfiles,
      this.#processBackends,
      this.#engineGateAvailable,
      this.#observers,
      this.#observerHostCaps,
      this.#sourceReaderHostCaps,
      this.#nativeDiagnosticSourceReader,
      this.#nativeObserverProfiles
    )
    if (expected.target === 'native' && admitted != null) {
      const middleware = this.#middleware.get(admitted.initialMiddlewareId)
      if (
        middleware?.behavior !== 'allow' || middleware.matcher != null || middleware.timeoutMs != null ||
        !nativeDeviceAvailable(admitted.sandboxPolicy, this.#nativeDeviceProvider)
      ) throw serviceError('sandbox.capability_unsupported', 'Native Capability Runtime binding is unavailable')
      nativeProcessProfile(admitted, this.#processProfiles, this.#processBackends)
    }
    return admitted
  }

  async prepare(process) {
    const request = process.capabilityRuntime
    if (request == null) return undefined
    const middleware = this.#middleware.get(request.initialMiddlewareId)
    if (middleware == null) {
      throw serviceError('service.precondition_failed', 'Initial middleware registration is no longer available')
    }
    if (process.target === 'native') {
      const policy = request.sandboxPolicy
      assertNativeCapabilityPolicyDigestV1(request)
      const diagnosticSourceReader = selectNativeDiagnosticSourceReaderForPolicy(
        policy,
        this.#nativeDiagnosticSourceReader
      )
      const diagnosticAudit = selectNativeDiagnosticAuditForPolicy(
        policy,
        this.#nativeDiagnosticAudit,
        diagnosticSourceReader
      )
      let observerProfiles
      try {
        observerProfiles = selectNativeRuntimeObserverProfilesV1(
          request.initialObserverIds,
          this.#nativeObserverProfiles,
          policy.diagnostics
        )
      } catch {
        throw serviceError('sandbox.capability_unsupported', 'Native Runtime Observer profile is unavailable')
      }
      assertNativeObserverVersions(request, observerProfiles)
      if (
        middleware.behavior !== 'allow' || middleware.matcher != null || middleware.timeoutMs != null ||
        !nativeDeviceAvailable(policy, this.#nativeDeviceProvider)
      ) {
        throw serviceError('sandbox.capability_unsupported', 'Native Capability Runtime binding is unavailable')
      }
      const processProfile = nativeProcessProfile(request, this.#processProfiles, this.#processBackends)
      return Object.freeze({
        context: request.context,
        policy,
        policyDigest: request.policyDigest,
        ...(observerProfiles.length === 0 ? {} : { observerProfiles }),
        ...(diagnosticSourceReader == null ? {} : { diagnosticSourceReader }),
        ...(diagnosticAudit == null ? {} : { diagnosticAudit }),
        ...(processProfile == null
          ? {}
          : { processProfile, processProfileId: request.processProfileId }),
        systemProjection: await (this.#factories.systemProjection?.({ policy, process, target: 'native' }) ??
          createDefaultHostSystemProjectionV1(policy))
      })
    }
    const processProfile = request.processProfileId == null
      ? undefined
      : this.#processProfiles.get(request.processProfileId)
    if (request.processProfileId != null && processProfile == null) {
      throw serviceError('service.precondition_failed', 'Process profile is no longer available')
    }
    return await prepareCapabilityRuntimeV1(
      process,
      middleware,
      this.#stateDirectory,
      this.#factories,
      processProfile,
      processProfile == null
        ? undefined
        : this.#processBackendInstallations.get(processProfile.backend.backendId),
      request.initialObserverIds.map(id => this.#observers.get(id))
    )
  }
}

export const createServiceCapabilityRuntimeManagerV1 = options => new ServiceCapabilityRuntimeManagerV1(options)
