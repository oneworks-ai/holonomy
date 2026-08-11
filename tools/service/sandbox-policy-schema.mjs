const integer = (minimum, maximum) => ({ maximum, minimum, type: 'integer' })

export const SANDBOX_NETWORK_LIMITS_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    maxChunkBytes: integer(1, 1024 * 1024),
    maxConcurrentConnections: integer(1, 128),
    maxHeaderBytes: integer(1, 1024 * 1024),
    maxHeaders: integer(1, 1024),
    maxRequestBodyBytes: integer(1, 64 * 1024 * 1024),
    maxResponseBodyBytes: integer(1, 256 * 1024 * 1024),
    maxUrlBytes: integer(1, 1024 * 1024),
    socketTimeoutMs: integer(1, 120_000)
  },
  required: [
    'maxChunkBytes',
    'maxConcurrentConnections',
    'maxHeaderBytes',
    'maxHeaders',
    'maxRequestBodyBytes',
    'maxResponseBodyBytes',
    'maxUrlBytes',
    'socketTimeoutMs'
  ],
  type: 'object'
})

const networkNone = {
  additionalProperties: false,
  properties: { access: { const: 'none' } },
  required: ['access'],
  type: 'object'
}

const networkEnabled = {
  additionalProperties: false,
  properties: {
    access: { enum: ['mockOnly', 'restricted'] },
    allowedOrigins: {
      items: { maxLength: 65_536, minLength: 1, type: 'string' },
      maxItems: 64,
      minItems: 1,
      type: 'array',
      uniqueItems: true
    },
    allowedSchemes: {
      items: { enum: ['http', 'https'] },
      maxItems: 2,
      minItems: 1,
      type: 'array',
      uniqueItems: true
    },
    allowPrivateNetwork: { type: 'boolean' },
    limits: SANDBOX_NETWORK_LIMITS_SCHEMA
  },
  required: ['access', 'allowedOrigins', 'allowedSchemes', 'allowPrivateNetwork', 'limits'],
  type: 'object'
}

export const SANDBOX_POLICY_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    filesystem: {
      additionalProperties: false,
      properties: { access: { enum: ['none', 'sandboxed'] } },
      required: ['access'],
      type: 'object'
    },
    network: { oneOf: [networkNone, networkEnabled] },
    schemaVersion: { const: 1 }
  },
  required: ['schemaVersion', 'network', 'filesystem'],
  type: 'object'
})
