const OPERATIONS = Object.freeze([
  'device.connectivity.cellular.state.read',
  'device.connectivity.read',
  'device.connectivity.wifi.identity.read',
  'device.connectivity.wifi.state.read',
  'device.display.read',
  'device.events.subscribe',
  'device.form-factor.read',
  'device.input.read',
  'device.lifecycle.read',
  'device.media.capabilities.read',
  'device.power.read',
  'device.security.capabilities.read',
  'device.sensor.capabilities.read',
  'device.summary.read',
  'device.thermal.read'
])

export const deviceOperations = target => {
  const required = target === 'node'
    ? new Set(['device.form-factor.read', 'device.lifecycle.read', 'device.summary.read'])
    : new Set([
      'device.display.read',
      'device.events.subscribe',
      'device.form-factor.read',
      'device.input.read',
      'device.lifecycle.read',
      'device.summary.read'
    ])
  return OPERATIONS.map(operation => ({
    eventKinds: operation === 'device.events.subscribe' && target === 'desktop'
      ? ['display', 'lifecycle']
      : [],
    maxPrecision: required.has(operation) ? 'standard' : 'none',
    operation,
    permissionModel: required.has(operation) ? 'host' : 'none',
    supportLevel: required.has(operation) ? 'required' : 'unsupported'
  }))
}

export const reading = value => ({
  observedAt: 100,
  precision: 'standard',
  revision: 1,
  status: 'available',
  value
})
