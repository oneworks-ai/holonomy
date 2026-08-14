const requiredByTarget = Object.freeze({
  android: new Set([
    'device.connectivity.cellular.state.read',
    'device.connectivity.read',
    'device.connectivity.wifi.state.read',
    'device.display.read',
    'device.events.subscribe',
    'device.form-factor.read',
    'device.input.read',
    'device.lifecycle.read',
    'device.power.read',
    'device.summary.read'
  ]),
  desktop: new Set([
    'device.display.read',
    'device.events.subscribe',
    'device.form-factor.read',
    'device.input.read',
    'device.lifecycle.read',
    'device.summary.read'
  ]),
  node: new Set([
    'device.form-factor.read',
    'device.lifecycle.read',
    'device.summary.read'
  ])
})

const eventsByTarget = Object.freeze({
  android: ['connectivity', 'display', 'lifecycle', 'power'],
  desktop: ['display', 'lifecycle'],
  node: []
})

export const deviceDescriptorInput = (target, operations) => ({
  operations: operations.map(operation => ({
    eventKinds: operation === 'device.events.subscribe' ? eventsByTarget[target] : [],
    maxPrecision: requiredByTarget[target].has(operation)
      ? 'standard'
      : target === 'node'
      ? 'none'
      : 'exact',
    operation,
    permissionModel: target === 'node' && !requiredByTarget[target].has(operation)
      ? 'none'
      : operation.includes('wifi.identity')
      ? 'hostAndPlatform'
      : 'host',
    supportLevel: requiredByTarget[target].has(operation)
      ? 'required'
      : target === 'node'
      ? 'unsupported'
      : 'optional'
  })),
  providerVersion: '1.0.0',
  schemaVersion: 1,
  target
})

export const androidDeviceDescriptorInput = operations => deviceDescriptorInput('android', operations)

export const capabilitySelectionInput = (digest, fsLimits, networkLimits) => ({
  available: [{
    constraints: {
      limits: fsLimits,
      roots: [{ pathPrefixSegments: [], rights: ['read', 'write'], rootId: 'workspace' }]
    },
    name: 'host.fs',
    version: 1
  }, {
    constraints: {
      allowPrivateNetwork: false,
      inspectRequestBodyBytes: 0,
      limits: networkLimits,
      mode: 'mockOnly',
      origins: ['https://api.example'],
      schemes: ['https']
    },
    name: 'host.network.mock',
    version: 1
  }],
  context: {
    generation: 3,
    policyDigest: digest,
    principal: 'holo:process-1:3',
    processId: 'process-1'
  },
  requirement: {
    anyOf: [{
      allOf: [{
        constraints: {
          limits: fsLimits,
          roots: [{ pathPrefixSegments: ['src'], rights: ['read'], rootId: 'workspace' }]
        },
        name: 'host.fs',
        version: 1
      }],
      branchId: 'fs-read'
    }]
  }
})

export const runtimeCreationInput = policy =>
  Object.freeze({
    configuration: {
      context: {
        guest: { displayName: 'Runtime example' },
        host: { tenantId: 'private-tenant' },
        inspector: { title: 'Runtime example' },
        schemaVersion: 1
      },
      inspector: { enabled: false },
      launch: {
        entryUrl: 'app+local://workspace/main.mjs',
        moduleCount: 1,
        moduleGraphDigest: '1'.repeat(64),
        moduleRootUrl: 'app+local://workspace/',
        totalSourceBytes: 32
      },
      sandboxPolicy: policy,
      schemaVersion: 1,
      systemProjection: { fields: {}, schemaVersion: 1 }
    },
    hostBindings: {
      engineGate: { bindingId: 'engine-gate', ownerId: 'host-owner', version: '1' },
      initialMiddlewareSet: {
        bindingId: 'middleware-set',
        ownerId: 'host-owner',
        version: '1'
      },
      initialObservers: [{ bindingId: 'observer-set', ownerId: 'host-owner', version: '1' }],
      moduleResolver: { bindingId: 'module-resolver', ownerId: 'host-owner', version: '1' },
      providerBindings: [{
        module: 'host.fs',
        ownerId: 'host-owner',
        providerId: 'fs-provider',
        providerVersion: '1'
      }]
    }
  })
