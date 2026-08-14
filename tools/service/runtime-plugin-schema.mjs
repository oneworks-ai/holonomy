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

export const RUNTIME_PLUGIN_BUNDLES_SCHEMA = Object.freeze({
  items: {
    additionalProperties: false,
    properties: {
      bundleSha256: { pattern: '^[a-f\\d]{64}$', type: 'string' },
      config: {},
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
  },
  maxItems: 128,
  type: 'array'
})
