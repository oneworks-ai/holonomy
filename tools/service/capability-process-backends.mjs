import { NODE_PROCESS_BACKEND_REGISTRY_V1 } from '../../adapters/node/src/capability-process-backend.mjs'
import {
  createNodeProcessBackendRegistryForInstallationV1,
  normalizeNodeProcessBackendInstallationV1
} from '../../adapters/node/src/capability-process-v86-installation.mjs'
import { readServiceProcessProfilesV1 } from './capability-process-profiles.mjs'
import { serviceError } from './errors.mjs'
import { readBoundedRegularFile } from './secure-file-read.mjs'

const BACKEND_ID = /^[A-Za-z0-9][\w.-]{0,127}$/u

const invalid = () => {
  throw serviceError('service.state_corrupt', 'Holonomy Process Backend manifest is invalid')
}

export const readServiceProcessBackendsV1 = async path => {
  let value
  try {
    const bytes = await readBoundedRegularFile(path, {
      label: 'Holonomy Process Backend manifest',
      maxBytes: 256 * 1024,
      ownerOnly: true
    })
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({
        installations: Object.freeze({}),
        registry: NODE_PROCESS_BACKEND_REGISTRY_V1
      })
    }
    if (error?.code === 'service.state_corrupt') throw error
    return invalid()
  }
  if (
    value == null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['backends', 'schemaVersion'].includes(key)) ||
    value.schemaVersion !== 1 || value.backends == null || typeof value.backends !== 'object' ||
    Array.isArray(value.backends) || Object.keys(value.backends).length > 16
  ) return invalid()
  let registry = NODE_PROCESS_BACKEND_REGISTRY_V1
  const installations = Object.create(null)
  for (const [backendId, input] of Object.entries(value.backends)) {
    if (!BACKEND_ID.test(backendId)) return invalid()
    let installation
    try {
      installation = normalizeNodeProcessBackendInstallationV1({ ...input, backendId })
      registry = createNodeProcessBackendRegistryForInstallationV1(installation)
    } catch {
      return invalid()
    }
    installations[backendId] = installation
  }
  return Object.freeze({ installations: Object.freeze(installations), registry })
}

export const readServiceProcessConfigurationV1 = async (paths, overrides = {}) => {
  const backends = overrides.capabilityProcessBackends ??
    await readServiceProcessBackendsV1(paths.processBackends)
  const profiles = overrides.capabilityProcessProfiles ??
    await readServiceProcessProfilesV1(paths.processProfiles, {
      processBackendInstallations: backends.installations,
      processBackendRegistry: backends.registry
    })
  return Object.freeze({ backends, profiles })
}
