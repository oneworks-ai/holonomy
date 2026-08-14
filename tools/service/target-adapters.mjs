import { serviceError } from './errors.mjs'

const METHODS = Object.freeze([
  'applyNetworkRules',
  'applyRuntimePlugins',
  'close',
  'closeInspector',
  'exposeFixture',
  'listEmulators',
  'listDevices',
  'openInspector',
  'readLogs',
  'reconcileProcess',
  'removeProcess',
  'removeNetworkRules',
  'restartEmulator',
  'resumeProcess',
  'startEmulator',
  'startProcess',
  'stopEmulator',
  'stopProcess',
  'subscribeProcess'
])

const unsupported = (target, operation) => async () => {
  throw serviceError('service.unsupported', `${target} adapter operation ${operation} is not configured`)
}

export const createTargetAdapter = (target, implementation = {}) => {
  if (target !== 'android' && target !== 'node') {
    throw serviceError('service.invalid_request', 'Target adapter name is invalid')
  }
  const adapter = { target }
  for (const method of METHODS) {
    const operation = implementation[method] ?? (
      method === 'subscribeProcess' ? (() => () => undefined) : unsupported(target, method)
    )
    if (typeof operation !== 'function') {
      throw serviceError('service.invalid_request', `Target adapter method ${method} must be a function`)
    }
    adapter[method] = async input => await operation(input)
  }
  return Object.freeze(adapter)
}

export const createNodeLocalAdapter = (implementation = {}) =>
  createTargetAdapter('node', {
    exposeFixture: async input => input.baseUrl,
    listDevices: async () => [{
      id: 'node:local',
      kind: 'local',
      platform: 'node',
      serial: 'local',
      state: 'online'
    }],
    ...implementation
  })

export const createTargetAdapterDispatcher = options => {
  const adapters = new Map()
  for (const adapter of [options.android, options.node]) {
    if (adapter != null) adapters.set(adapter.target, adapter)
  }
  const getAdapter = target => {
    const adapter = adapters.get(target)
    if (adapter == null) throw serviceError('service.unsupported', `Target adapter ${target} is not configured`)
    return adapter
  }
  return Object.freeze({
    async listDevices(input) {
      const results = await Promise.allSettled([...adapters.values()].map(adapter => adapter.listDevices(input)))
      const available = results.filter(result => result.status === 'fulfilled').flatMap(result => result.value)
      if (available.length === 0 && results.every(result => result.status === 'rejected')) {
        throw serviceError('service.unavailable', 'Device discovery is unavailable')
      }
      return available
    },
    async close() {
      await Promise.allSettled([...adapters.values()].map(adapter => adapter.close({})))
    },
    target(target) {
      return getAdapter(target)
    },
    targets: Object.freeze([...adapters.keys()])
  })
}
