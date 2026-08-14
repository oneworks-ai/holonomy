import { NODE_PROCESS_BACKEND_REGISTRY_V1 } from '../../adapters/node/src/capability-process-backend.mjs'
import { verifyInstalledV86ProcessProfileV1 } from '../../adapters/node/src/capability-process-v86-installation.mjs'
import { normalizeNodeProcessProfileV1 } from '../../adapters/node/src/capability-session.mjs'
import { serviceError } from './errors.mjs'
import { readBoundedRegularFile } from './secure-file-read.mjs'

const PROFILE_ID = /^[A-Za-z0-9][\w.-]{0,127}$/u

const invalid = () => {
  throw serviceError('service.state_corrupt', 'Holonomy Process profile manifest is invalid')
}

export const readServiceProcessProfilesV1 = async (path, options = {}) => {
  const registry = options.processBackendRegistry ?? NODE_PROCESS_BACKEND_REGISTRY_V1
  const installations = options.processBackendInstallations ?? Object.freeze({})
  let value
  try {
    const bytes = await readBoundedRegularFile(path, {
      label: 'Holonomy Process profile manifest',
      maxBytes: 1024 * 1024,
      ownerOnly: true
    })
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({})
    if (error?.code === 'service.state_corrupt') throw error
    return invalid()
  }
  if (
    value == null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['profiles', 'schemaVersion'].includes(key)) ||
    value.schemaVersion !== 1 || value.profiles == null || typeof value.profiles !== 'object' ||
    Array.isArray(value.profiles) || Object.keys(value.profiles).length > 64
  ) return invalid()
  const output = Object.create(null)
  for (const [id, profile] of Object.entries(value.profiles)) {
    if (!PROFILE_ID.test(id)) return invalid()
    try {
      output[id] = normalizeNodeProcessProfileV1(profile, registry)
      const installation = installations[output[id].backend.backendId]
      if (installation != null) await verifyInstalledV86ProcessProfileV1(output[id], installation)
    } catch {
      return invalid()
    }
  }
  return Object.freeze(output)
}
