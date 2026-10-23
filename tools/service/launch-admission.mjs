import { normalizeModuleGraphRoot } from '../../adapters/node/src/module-root-validation.mjs'

import { serviceError } from './errors.mjs'
import { validateNativeLaunchGraph } from './native-launch-materialization.mjs'
import { cloneJson, requireRecord } from './validation.mjs'

const PUBLIC_LAUNCH_FIELDS = Object.freeze([
  'argv',
  'command',
  'entryUrl',
  'env',
  'moduleRootUrl',
  'moduleAliases',
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
  if (expected.target !== 'native' && Object.hasOwn(launch, 'moduleAliases')) {
    throw serviceError('service.invalid_request', 'Module aliases require a Native target')
  }
  if (
    expected.target !== 'native' && Array.isArray(launch.modules) &&
    launch.modules.some(module => module != null && Object.hasOwn(module, 'metadataOnly'))
  ) {
    throw serviceError('service.invalid_request', 'Metadata-only module rows require a Native target')
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
  if (expected.target === 'native') validateNativeLaunchGraph(launch)
  return launch
}
