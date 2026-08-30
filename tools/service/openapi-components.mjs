/* eslint-disable max-lines -- This declarative OpenAPI component table remains a single generated-document owner. */

import { SERVICE_ERROR_CODES } from './errors.mjs'
import { SERVICE_REQUEST_SCHEMAS } from './request-schemas.mjs'

export const OPENAPI_COMPONENTS = {
  schemas: {
    Device: {
      additionalProperties: true,
      properties: {
        id: { type: 'string' },
        kind: { enum: ['emulator', 'local', 'physical', 'unknown'] },
        platform: { enum: ['android', 'node'] },
        serial: { type: 'string' },
        state: { enum: ['disconnected', 'offline', 'online', 'unauthorized', 'unknown'] }
      },
      required: ['id', 'kind', 'platform', 'serial', 'state'],
      type: 'object'
    },
    Error: {
      properties: {
        error: {
          properties: {
            code: { enum: SERVICE_ERROR_CODES, type: 'string' },
            details: { type: 'object' },
            message: { type: 'string' },
            retryable: { type: 'boolean' }
          },
          required: ['code', 'message', 'retryable'],
          type: 'object'
        }
      },
      required: ['error'],
      type: 'object'
    },
    Emulator: {
      additionalProperties: true,
      properties: {
        id: { type: 'string' },
        state: { type: 'string' }
      },
      required: ['id', 'state'],
      type: 'object'
    },
    InspectorLease: {
      additionalProperties: true,
      properties: {
        generation: { minimum: 1, type: 'integer' },
        id: { type: 'string' },
        processId: { type: 'string' },
        state: { enum: ['allocating', 'closed', 'failed', 'lost', 'ready'] }
      },
      required: ['generation', 'id', 'processId', 'state'],
      type: 'object'
    },
    NetworkRules: {
      additionalProperties: true,
      properties: {
        generation: { minimum: 1, type: 'integer' },
        id: { type: 'string' },
        mode: { enum: ['failClosed', 'passthrough'] },
        processId: { type: 'string' },
        ruleRevision: { type: 'string' },
        rules: { items: { type: 'object' }, maxItems: 256, type: 'array' },
        state: { enum: ['active', 'applying', 'failed', 'removed'] }
      },
      required: ['generation', 'id', 'mode', 'processId', 'ruleRevision', 'rules', 'state'],
      type: 'object'
    },
    Operation: {
      additionalProperties: true,
      properties: {
        id: { type: 'string' },
        kind: { type: 'string' },
        state: { enum: ['cancelled', 'failed', 'queued', 'running', 'succeeded'] },
        target: { type: 'object' }
      },
      required: ['id', 'kind', 'state', 'target'],
      type: 'object'
    },
    Process: {
      additionalProperties: false,
      allOf: [
        {
          if: {
            properties: { sandboxPolicyState: { const: 'effective' } },
            required: ['sandboxPolicyState']
          },
          then: { required: ['sandboxPolicy', 'sandboxPolicyDigest'] }
        },
        {
          if: {
            properties: { sandboxPolicyState: { const: 'pending' } },
            required: ['sandboxPolicyState']
          },
          then: { properties: { sandboxPolicy: false, sandboxPolicyDigest: false } }
        }
      ],
      properties: {
        activeOperationId: { type: 'string' },
        capabilityContextDigest: { pattern: '^[0-9a-f]{64}$', type: 'string' },
        capabilityPolicyDigest: { pattern: '^[0-9a-f]{64}$', type: 'string' },
        capabilityRuntimeState: { const: 'provider-v1' },
        cleanupPending: { type: 'boolean' },
        createdAt: { minimum: 0, type: 'integer' },
        deviceId: { type: 'string' },
        endedAt: { minimum: 0, type: 'integer' },
        entryUrl: { format: 'uri', type: 'string' },
        exit: {
          additionalProperties: false,
          properties: {
            code: { type: 'integer' },
            reason: { type: 'string' }
          },
          required: ['reason'],
          type: 'object'
        },
        generation: { minimum: 1, type: 'integer' },
        id: { type: 'string' },
        inspectorMode: { enum: ['break', 'enabled', 'off'] },
        isolation: { enum: ['isolatedProcess', 'runtime'] },
        pluginGraphRevision: { minimum: 0, type: 'integer' },
        revision: { minimum: 1, type: 'integer' },
        sandboxPolicy: SERVICE_REQUEST_SCHEMAS.ProcessStartRequest.properties.sandboxPolicy,
        sandboxPolicyDigest: { pattern: '^[0-9a-f]{64}$', type: 'string' },
        sandboxPolicyState: { enum: ['effective', 'pending'] },
        sessionId: { type: 'string' },
        target: { enum: ['android', 'node'] },
        updatedAt: { minimum: 0, type: 'integer' },
        state: {
          enum: [
            'cancelled',
            'exited',
            'failed',
            'lost',
            'queued',
            'running',
            'staging',
            'starting',
            'stopping',
            'waiting_for_debugger'
          ]
        }
      },
      required: [
        'deviceId',
        'createdAt',
        'entryUrl',
        'generation',
        'id',
        'inspectorMode',
        'isolation',
        'pluginGraphRevision',
        'revision',
        'sandboxPolicyState',
        'sessionId',
        'state',
        'target',
        'updatedAt'
      ],
      type: 'object'
    },
    ProcessAdmission: {
      additionalProperties: false,
      properties: {
        replayed: { type: 'boolean' },
        value: {
          additionalProperties: false,
          properties: {
            networkRules: { $ref: '#/components/schemas/NetworkRules' },
            operation: { $ref: '#/components/schemas/Operation' },
            process: { $ref: '#/components/schemas/Process' }
          },
          required: ['operation', 'process'],
          type: 'object'
        }
      },
      required: ['replayed', 'value'],
      type: 'object'
    },
    ProcessRemoval: {
      additionalProperties: false,
      properties: {
        process: { $ref: '#/components/schemas/Process' },
        removed: {
          additionalProperties: false,
          properties: {
            idempotency: { minimum: 0, type: 'integer' },
            inspectors: { minimum: 0, type: 'integer' },
            networkRules: { minimum: 0, type: 'integer' },
            operations: { minimum: 0, type: 'integer' },
            process: { const: 1 }
          },
          required: ['idempotency', 'inspectors', 'networkRules', 'operations', 'process'],
          type: 'object'
        },
        removedAt: { minimum: 0, type: 'integer' }
      },
      required: ['process', 'removed', 'removedAt'],
      type: 'object'
    },
    ...SERVICE_REQUEST_SCHEMAS
  },
  securitySchemes: {
    bearerAuth: { scheme: 'bearer', type: 'http' }
  }
}
