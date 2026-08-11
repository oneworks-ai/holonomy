import { normalizeModuleGraphRoot } from '../../adapters/node/src/module-root-validation.mjs'

import { serviceError } from './errors.mjs'
import { cloneJson, requireRecord } from './validation.mjs'

const PUBLIC_LAUNCH_FIELDS = Object.freeze([
  'argv',
  'command',
  'entryUrl',
  'env',
  'moduleRootUrl',
  'modules',
  'reporter',
  'schemaVersion',
  'target'
])

export const admitLaunchSnapshot = (value, expected) => {
  const launch = cloneJson(requireRecord(value, 'Runtime launch snapshot'))
  if (Object.keys(launch).some(key => !PUBLIC_LAUNCH_FIELDS.includes(key))) {
    throw serviceError('service.invalid_request', 'Runtime launch snapshot contains a host-owned field')
  }
  if (launch.schemaVersion != null && launch.schemaVersion !== 2) {
    throw serviceError('service.invalid_request', 'Runtime launch snapshot version is invalid')
  }
  if (launch.entryUrl != null && launch.entryUrl !== expected.entryUrl) {
    throw serviceError('service.invalid_request', 'Runtime launch entry does not match the request')
  }
  if (launch.target != null && launch.target !== expected.target) {
    throw serviceError('service.invalid_request', 'Runtime launch target does not match the request')
  }
  if (launch.moduleRootUrl != null) {
    const urls = [
      expected.entryUrl,
      ...(Array.isArray(launch.modules) ? launch.modules.map(module => module?.url) : [])
    ]
    try {
      launch.moduleRootUrl = normalizeModuleGraphRoot(launch.moduleRootUrl, urls)
    } catch {
      throw serviceError('service.invalid_request', 'Runtime module root URL is invalid')
    }
  }
  return launch
}
