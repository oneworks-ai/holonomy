import Ajv2020 from 'ajv/dist/2020.js'

import { NETWORK_RULE_SET_SCHEMA, createNetworkRuleSetSchema } from '../../adapters/node/src/network-rule-schema.mjs'
// eslint-disable-next-line antfu/no-import-dist
import { RUNTIME_CONTEXT_ENVELOPE_V1_SCHEMA, SANDBOX_POLICY_V2_SCHEMA } from '../../dist/capability-runtime/index.js'
import { serviceError } from './errors.mjs'
import { RUNTIME_PLUGIN_BUNDLES_SCHEMA } from './runtime-plugin-schema.mjs'
import { SANDBOX_POLICY_SCHEMA } from './sandbox-policy-schema.mjs'

export const SERVICE_REQUEST_DIALECT = 'https://json-schema.org/draft/2020-12/schema'

const expectedGeneration = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: 1,
  type: 'integer'
}

const { $id: _capabilityPolicyId, $schema: _capabilityPolicyDialect, ...capabilitySandboxPolicy } =
  SANDBOX_POLICY_V2_SCHEMA

export const CAPABILITY_RUNTIME_START_SCHEMA = Object.freeze({
  additionalProperties: false,
  description: 'Atomic Capability Runtime configuration selected before Runtime entry',
  properties: {
    context: RUNTIME_CONTEXT_ENVELOPE_V1_SCHEMA,
    initialMiddlewareId: {
      maxLength: 160,
      minLength: 1,
      pattern: '^[\\w:.-]+$',
      type: 'string'
    },
    processProfileId: {
      description: 'Logical id from the private Host Process profile manifest; native paths are never accepted here',
      maxLength: 128,
      minLength: 1,
      pattern: '^[A-Za-z0-9][\\w.-]{0,127}$',
      type: 'string'
    },
    sandboxPolicy: capabilitySandboxPolicy,
    schemaVersion: { const: 1 }
  },
  required: ['context', 'initialMiddlewareId', 'sandboxPolicy', 'schemaVersion'],
  type: 'object'
})

export const SERVICE_REQUEST_SCHEMAS = {
  ExpectedGenerationRequest: {
    $schema: SERVICE_REQUEST_DIALECT,
    additionalProperties: false,
    properties: { expectedGeneration },
    required: ['expectedGeneration'],
    type: 'object'
  },
  EmulatorStartRequest: {
    $schema: SERVICE_REQUEST_DIALECT,
    additionalProperties: false,
    properties: {
      coldBoot: { type: 'boolean' },
      wipeData: { type: 'boolean' }
    },
    type: 'object'
  },
  InspectorOpenRequest: {
    $schema: SERVICE_REQUEST_DIALECT,
    additionalProperties: false,
    properties: {
      expectedGeneration,
      openDevTools: { type: 'boolean' }
    },
    required: ['expectedGeneration'],
    type: 'object'
  },
  NetworkRulesReplaceRequest: {
    $schema: SERVICE_REQUEST_DIALECT,
    ...createNetworkRuleSetSchema({ expectedGeneration }, ['expectedGeneration'])
  },
  ProcessStartRequest: {
    $schema: SERVICE_REQUEST_DIALECT,
    additionalProperties: false,
    properties: {
      capabilityRuntime: CAPABILITY_RUNTIME_START_SCHEMA,
      deviceId: { pattern: '^[\\w:.-]{1,160}$', type: 'string' },
      entryUrl: { maxLength: 4_096, minLength: 1, type: 'string' },
      fixture: {
        additionalProperties: false,
        properties: { kind: { const: 'conformance-network-v1' } },
        required: ['kind'],
        type: 'object'
      },
      initialNetworkRuleSet: NETWORK_RULE_SET_SCHEMA,
      inspectorMode: { enum: ['break', 'enabled', 'off'] },
      isolation: { enum: ['isolatedProcess', 'runtime'] },
      launch: {
        additionalProperties: false,
        properties: {
          argv: { items: { maxLength: 16_384, type: 'string' }, maxItems: 256, type: 'array' },
          command: { enum: ['run', 'test'] },
          entryUrl: { maxLength: 4_096, minLength: 1, type: 'string' },
          env: {
            additionalProperties: { maxLength: 65_536, type: 'string' },
            maxProperties: 256,
            propertyNames: { maxLength: 256, minLength: 1 },
            type: 'object'
          },
          moduleRootUrl: { maxLength: 4_096, minLength: 1, type: 'string' },
          modules: {
            items: {
              additionalProperties: false,
              properties: {
                source: { maxLength: 8 * 1024 * 1024, type: 'string' },
                url: { maxLength: 4_096, minLength: 1, type: 'string' }
              },
              required: ['source', 'url'],
              type: 'object'
            },
            minItems: 1,
            maxItems: 512,
            type: 'array'
          },
          reporter: { enum: ['json', 'tap'] },
          schemaVersion: { const: 2 },
          target: { enum: ['android', 'node'] }
        },
        required: ['entryUrl', 'moduleRootUrl', 'modules', 'schemaVersion', 'target'],
        type: 'object'
      },
      runtimePlugins: RUNTIME_PLUGIN_BUNDLES_SCHEMA,
      sandboxPolicy: SANDBOX_POLICY_SCHEMA,
      target: { enum: ['android', 'node'] }
    },
    required: ['deviceId', 'entryUrl', 'inspectorMode', 'isolation', 'launch', 'target'],
    type: 'object'
  },
  RuntimePluginsReplaceRequest: {
    $schema: SERVICE_REQUEST_DIALECT,
    additionalProperties: false,
    properties: {
      expectedGeneration,
      runtimePlugins: RUNTIME_PLUGIN_BUNDLES_SCHEMA
    },
    required: ['expectedGeneration', 'runtimePlugins'],
    type: 'object'
  },
  ServiceShutdownRequest: {
    $schema: SERVICE_REQUEST_DIALECT,
    additionalProperties: false,
    properties: { drain: { type: 'boolean' } },
    required: ['drain'],
    type: 'object'
  },
  ServiceTokenRotateRequest: {
    $schema: SERVICE_REQUEST_DIALECT,
    additionalProperties: false,
    properties: {},
    type: 'object'
  }
}

const ajv = new Ajv2020({ allErrors: false, strict: true, validateFormats: false })
const validators = Object.fromEntries(
  Object.entries(SERVICE_REQUEST_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)])
)

export const validateServiceRequest = (schemaName, value) => {
  const validator = validators[schemaName]
  if (validator == null) throw serviceError('service.internal', 'Request schema is not registered')
  if (!validator(value)) {
    throw serviceError('service.invalid_request', 'Request body does not match the OpenAPI schema')
  }
  return value
}
