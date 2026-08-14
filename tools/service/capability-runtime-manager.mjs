import { NODE_PROCESS_BACKEND_REGISTRY_V1 } from '../../adapters/node/src/capability-process-backend.mjs'
import { normalizeNodeProcessBackendInstallationV1 } from '../../adapters/node/src/capability-process-v86-installation.mjs'
import { normalizeNodeProcessProfileV1 } from '../../adapters/node/src/capability-session.mjs'
import {
  admitCapabilityRuntimeRequestV1,
  normalizeCapabilityMiddlewareRegistryV1
} from './capability-runtime-admission.mjs'
import { prepareCapabilityRuntimeV1 } from './capability-runtime-preparation.mjs'
import { serviceError } from './errors.mjs'

const requireProfileId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][\w.-]{0,127}$/u.test(value)) {
    throw new TypeError('Process profile id is invalid')
  }
  return value
}

export class ServiceCapabilityRuntimeManagerV1 {
  #middleware
  #stateDirectory
  #factories
  #processProfiles
  #processBackends
  #processBackendInstallations

  constructor(options = {}) {
    this.#middleware = normalizeCapabilityMiddlewareRegistryV1(options.middlewareRegistry)
    this.#stateDirectory = options.stateDirectory
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
    return admitCapabilityRuntimeRequestV1(
      value,
      expected,
      this.#middleware,
      this.#processProfiles,
      this.#processBackends
    )
  }

  async prepare(process) {
    const request = process.capabilityRuntime
    if (request == null) return undefined
    const middleware = this.#middleware.get(request.initialMiddlewareId)
    if (middleware == null) {
      throw serviceError('service.precondition_failed', 'Initial middleware registration is no longer available')
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
        : this.#processBackendInstallations.get(processProfile.backend.backendId)
    )
  }
}

export const createServiceCapabilityRuntimeManagerV1 = options => new ServiceCapabilityRuntimeManagerV1(options)
