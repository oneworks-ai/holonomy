import { integerSchema, noneSchema, strictObject, stringSetSchema } from './schema-primitives.js'

const limits = strictObject({
  maxConcurrentProcesses: integerSchema(1, 64),
  maxExecutionTimeMs: integerSchema(1, 86_400_000),
  maxOpenPipes: integerSchema(0, 256),
  maxProcessTreeDepth: integerSchema(1, 32),
  maxStderrBytes: integerSchema(1, 16 * 1024 * 1024),
  maxStdinBytes: integerSchema(1, 16 * 1024 * 1024),
  maxStdoutBytes: integerSchema(1, 16 * 1024 * 1024),
  maxTotalProcesses: integerSchema(1, 100_000),
  maxWritableRootfsBytes: integerSchema(0, 4 * 1024 * 1024 * 1024)
})

const identifier = { maxLength: 128, minLength: 1, pattern: '^[A-Za-z0-9._-]+$', type: 'string' }
const shell = Object.freeze({
  oneOf: [noneSchema, strictObject({ access: { const: 'restricted' }, executableId: identifier })]
})
const network = Object.freeze({
  oneOf: [
    noneSchema,
    strictObject({
      access: { const: 'restricted' },
      endpoints: {
        items: strictObject({
          hostname: { maxLength: 253, minLength: 1, type: 'string' },
          ports: stringSetSchema(integerSchema(1, 65_535), 1, 64),
          transport: { enum: ['tcp', 'tls'] }
        }),
        maxItems: 256,
        minItems: 0,
        type: 'array'
      },
      maxSockets: integerSchema(1, 256)
    })
  ]
})

export const PROCESS_SANDBOX_V2_SCHEMA = Object.freeze({
  oneOf: [
    noneSchema,
    strictObject({
      access: { const: 'sandboxed' },
      environment: strictObject({
        allowedNames: stringSetSchema({ maxLength: 128, minLength: 1, type: 'string' }, 0, 256),
        maxValueBytes: integerSchema(1, 16 * 1024 * 1024)
      }),
      executables: {
        items: strictObject({
          argumentBytes: integerSchema(1, 16 * 1024 * 1024),
          executableId: identifier
        }),
        maxItems: 256,
        minItems: 1,
        type: 'array'
      },
      limits,
      mounts: {
        items: strictObject({
          guestPath: { maxLength: 4096, minLength: 1, pattern: '^/', type: 'string' },
          rights: stringSetSchema({ enum: ['read', 'write'] }, 1, 2),
          rootId: identifier
        }),
        maxItems: 64,
        minItems: 0,
        type: 'array'
      },
      network,
      shell
    })
  ]
})
