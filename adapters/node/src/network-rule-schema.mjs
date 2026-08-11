const pair = {
  items: false,
  maxItems: 2,
  minItems: 2,
  prefixItems: [{ maxLength: 256, minLength: 1, type: 'string' }, { maxLength: 1_048_576, type: 'string' }],
  type: 'array'
}

const entries = {
  additionalProperties: false,
  properties: {
    absent: { items: { maxLength: 256, minLength: 1, type: 'string' }, maxItems: 256, type: 'array' },
    entries: { items: pair, maxItems: 256, type: 'array' },
    mode: { enum: ['exact', 'subset'] }
  },
  required: ['entries', 'mode'],
  type: 'object'
}

const bodyMatch = {
  additionalProperties: false,
  properties: {
    kind: { enum: ['base64', 'empty', 'json', 'jsonSubset', 'sha256', 'utf8'] },
    value: {}
  },
  required: ['kind'],
  type: 'object'
}

const responseBody = {
  additionalProperties: false,
  properties: {
    chunks: { items: { maxLength: 1_048_576, type: 'string' }, maxItems: 256, type: 'array' },
    kind: { enum: ['base64', 'json', 'utf8'] },
    value: {}
  },
  required: ['kind'],
  type: 'object'
}

const action = {
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        body: responseBody,
        delayMs: { maximum: 60_000, minimum: 0, type: 'integer' },
        headers: { items: pair, maxItems: 256, type: 'array' },
        status: { maximum: 599, minimum: 200, type: 'integer' },
        type: { const: 'respond' }
      },
      required: ['status', 'type'],
      type: 'object'
    },
    {
      additionalProperties: false,
      properties: {
        code: { enum: ['connection_refused', 'timeout', 'unavailable'] },
        delayMs: { maximum: 60_000, minimum: 0, type: 'integer' },
        type: { const: 'fail' }
      },
      required: ['code', 'type'],
      type: 'object'
    },
    {
      additionalProperties: false,
      properties: { type: { const: 'passthrough' } },
      required: ['type'],
      type: 'object'
    }
  ]
}

const rule = {
  additionalProperties: false,
  properties: {
    action,
    id: { maxLength: 256, minLength: 1, type: 'string' },
    lifetime: {
      additionalProperties: false,
      properties: {
        expiresAt: { maxLength: 64, minLength: 1, type: 'string' },
        maxMatches: { maximum: Number.MAX_SAFE_INTEGER, minimum: 1, type: 'integer' }
      },
      type: 'object'
    },
    match: {
      additionalProperties: false,
      properties: {
        body: bodyMatch,
        headers: entries,
        method: { maxLength: 64, pattern: '^[A-Z]+$', type: 'string' },
        origin: { maxLength: 4_096, minLength: 1, type: 'string' },
        path: {
          additionalProperties: false,
          properties: {
            op: { enum: ['exact', 'prefix'] },
            value: { maxLength: 4_096, pattern: '^/', type: 'string' }
          },
          required: ['op', 'value'],
          type: 'object'
        },
        query: entries
      },
      type: 'object'
    },
    priority: { maximum: 1_000_000, minimum: -1_000_000, type: 'integer' }
  },
  required: ['action', 'id', 'match', 'priority'],
  type: 'object'
}

export const NETWORK_RULE_SET_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    mode: { enum: ['failClosed', 'passthrough'] },
    rules: { items: rule, maxItems: 256, type: 'array' }
  },
  required: ['mode', 'rules'],
  type: 'object'
})

export const createNetworkRuleSetSchema = (properties = {}, required = []) => ({
  ...NETWORK_RULE_SET_SCHEMA,
  properties: { ...NETWORK_RULE_SET_SCHEMA.properties, ...properties },
  required: [...NETWORK_RULE_SET_SCHEMA.required, ...required]
})
