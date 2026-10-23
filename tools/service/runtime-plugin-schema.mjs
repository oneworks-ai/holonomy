const pluginFile = {
  additionalProperties: false,
  properties: {
    sha256: { pattern: '^[a-f\\d]{64}$', type: 'string' },
    source: { maxLength: 8 * 1024 * 1024, type: 'string' },
    url: { maxLength: 4_096, pattern: '^holo-plugins:///', type: 'string' }
  },
  required: ['sha256', 'source', 'url'],
  type: 'object'
}

const bundleV1 = {
  additionalProperties: false,
  properties: {
    bundleSha256: { pattern: '^[a-f\\d]{64}$', type: 'string' },
    config: {},
    configSchema: { anyOf: [{ type: 'object' }, { type: 'boolean' }] },
    entryUrl: { maxLength: 4_096, pattern: '^holo-plugins:///', type: 'string' },
    exportName: { maxLength: 256, pattern: '^[$A-Z_a-z][$\\w]*$', type: 'string' },
    files: { items: pluginFile, maxItems: 512, minItems: 1, type: 'array' },
    instanceId: { maxLength: 128, pattern: '^[A-Za-z0-9][\\w.-]{0,127}$', type: 'string' },
    rootUrl: { maxLength: 4_096, pattern: '^holo-plugins:///.+/$', type: 'string' },
    schemaVersion: { const: 1 }
  },
  required: [
    'bundleSha256',
    'config',
    'entryUrl',
    'exportName',
    'files',
    'instanceId',
    'rootUrl',
    'schemaVersion'
  ],
  type: 'object'
}

const sourceRead = {
  additionalProperties: false,
  properties: {
    byteLength: { minimum: 0, maximum: 8 * 1024 * 1024, type: 'integer' },
    bytesBase64: { maxLength: Math.ceil(8 * 1024 * 1024 / 3) * 4, type: 'string' },
    sha256: { pattern: '^[a-f\\d]{64}$', type: 'string' },
    url: { maxLength: 4_096, pattern: '^holo-plugins:///', type: 'string' }
  },
  required: ['byteLength', 'bytesBase64', 'sha256', 'url'],
  type: 'object'
}

const sourceAlias = {
  additionalProperties: false,
  properties: {
    url: { maxLength: 4_096, pattern: '^holo-plugins:///', type: 'string' },
    canonicalUrl: { maxLength: 4_096, pattern: '^holo-plugins:///', type: 'string' }
  },
  required: ['url', 'canonicalUrl'],
  type: 'object'
}

const bundleV2 = {
  additionalProperties: false,
  properties: {
    bundleSha256: { pattern: '^[a-f\\d]{64}$', type: 'string' },
    config: {},
    configSchema: { anyOf: [{ type: 'object' }, { type: 'boolean' }] },
    entryUrl: { maxLength: 4_096, pattern: '^holo-plugins:///', type: 'string' },
    exportName: { maxLength: 256, pattern: '^[$A-Z_a-z][$\\w]*$', type: 'string' },
    instanceId: { maxLength: 128, pattern: '^[A-Za-z0-9][\\w.-]{0,127}$', type: 'string' },
    rootUrl: { maxLength: 4_096, pattern: '^holo-plugins:///.+/$', type: 'string' },
    schemaVersion: { const: 2 },
    sourceClosure: {
      additionalProperties: false,
      properties: {
        kind: { const: 'source-closure' },
        entryUrl: { maxLength: 4_096, pattern: '^holo-plugins:///', type: 'string' },
        rootUrl: { maxLength: 4_096, pattern: '^holo-plugins:///.+/$', type: 'string' },
        reads: { items: sourceRead, maxItems: 512, minItems: 1, type: 'array' },
        aliases: { items: sourceAlias, maxItems: 512, type: 'array' },
        externalReferences: { maxItems: 0, type: 'array' }
      },
      required: ['kind', 'entryUrl', 'rootUrl', 'reads', 'aliases', 'externalReferences'],
      type: 'object'
    }
  },
  required: [
    'bundleSha256',
    'config',
    'entryUrl',
    'exportName',
    'instanceId',
    'rootUrl',
    'schemaVersion',
    'sourceClosure'
  ],
  type: 'object'
}

export const RUNTIME_PLUGIN_BUNDLES_SCHEMA = Object.freeze({
  description: 'Immutable plugin bundles. Source-closure V2 requires a Native target.',
  items: { oneOf: [bundleV1, bundleV2] },
  maxItems: 128,
  type: 'array'
})
