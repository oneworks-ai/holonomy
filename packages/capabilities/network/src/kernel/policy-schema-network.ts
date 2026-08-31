import { integerSchema, noneSchema, strictObject, stringSetSchema } from '@holonomyjs/runtime/kernel/schema-primitives'

const networkLimits = strictObject({
  maxChunkBytes: integerSchema(1, 1024 * 1024),
  maxConcurrentConnections: integerSchema(1, 128),
  maxHeaderBytes: integerSchema(1, 1024 * 1024),
  maxHeaders: integerSchema(1, 1024),
  maxRedirects: integerSchema(0, 32),
  maxRequestBodyBytes: integerSchema(1, 64 * 1024 * 1024),
  maxResponseBodyBytes: integerSchema(1, 256 * 1024 * 1024),
  maxUrlBytes: integerSchema(1, 1024 * 1024),
  socketTimeoutMs: integerSchema(1, 120_000)
})

const requestBodyInspection = Object.freeze({
  oneOf: [
    noneSchema,
    strictObject({
      access: { const: 'bounded' },
      maxBytes: integerSchema(1, 1024 * 1024),
      maxReadsPerRuntime: integerSchema(1, 1024)
    })
  ]
})

export const NETWORK_SANDBOX_V2_SCHEMA = Object.freeze({
  oneOf: [
    noneSchema,
    strictObject({
      access: { enum: ['mockOnly', 'restricted'] },
      allowedOrigins: stringSetSchema({ maxLength: 2048, minLength: 1, type: 'string' }, 0, 64),
      allowedSchemes: stringSetSchema({ enum: ['http', 'https'] }, 0, 2),
      allowPrivateNetwork: { type: 'boolean' },
      limits: networkLimits,
      requestBodyInspection
    })
  ]
})
