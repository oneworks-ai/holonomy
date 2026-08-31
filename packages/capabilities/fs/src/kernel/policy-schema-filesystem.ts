import { integerSchema, noneSchema, strictObject, stringSetSchema } from '@holonomyjs/runtime/kernel/schema-primitives'

const root = strictObject({
  rights: stringSetSchema(
    { enum: ['create', 'delete', 'list', 'move', 'read', 'watch', 'write'] },
    1,
    7
  ),
  rootId: { maxLength: 64, minLength: 1, pattern: '^[A-Za-z0-9._-]+$', type: 'string' },
  symlinks: { enum: ['deny', 'withinRoot'] },
  virtualUrl: { maxLength: 4096, minLength: 11, pattern: '^holo-fs://', type: 'string' }
})

export const FILESYSTEM_SANDBOX_V2_SCHEMA = Object.freeze({
  oneOf: [
    noneSchema,
    strictObject({
      access: { const: 'sandboxed' },
      limits: strictObject({
        maxDirectoryEntries: integerSchema(1, 100_000),
        maxOpenHandles: integerSchema(1, 4096),
        maxQueuedEvents: integerSchema(0, 4096),
        maxReadBytes: integerSchema(1, 256 * 1024 * 1024),
        maxWatchers: integerSchema(0, 1024),
        maxWriteBytes: integerSchema(1, 256 * 1024 * 1024)
      }),
      roots: { items: root, maxItems: 64, minItems: 1, type: 'array' }
    })
  ]
})
