import {
  actionBodyReference,
  idParameter,
  mutationHeaders,
  reference,
  resourceListOperation,
  response,
  revisionHeader,
  secured
} from './openapi-helpers.mjs'

export const OPENAPI_PATHS = {
  '/healthz': {
    get: {
      operationId: 'getServiceHealth',
      responses: { 200: response('Service health') },
      tags: ['Control']
    }
  },
  '/openapi.json': {
    get: {
      operationId: 'getOpenApiDocument',
      responses: { 200: response('OpenAPI document') },
      tags: ['Control']
    }
  },
  '/v1/devices': {
    get: { ...resourceListOperation('Devices', 'Device'), operationId: 'listDevices' }
  },
  '/v1/devices:refresh': {
    post: secured({
      operationId: 'refreshDevices',
      responses: { 200: response('Refreshed devices', { items: reference('Device'), type: 'array' }) },
      tags: ['Devices']
    })
  },
  '/v1/devices/{deviceId}': {
    get: secured({
      operationId: 'getDevice',
      parameters: [idParameter('deviceId', 'Device id')],
      responses: { 200: response('Device', reference('Device')) },
      tags: ['Devices']
    })
  },
  '/v1/events': {
    get: secured({
      operationId: 'followEvents',
      parameters: [{ in: 'query', name: 'after', schema: { minimum: 0, type: 'integer' } }],
      responses: {
        200: {
          content: { 'text/event-stream': { schema: { type: 'string' } } },
          description: 'Cursor-addressed service events'
        }
      },
      tags: ['Events']
    })
  },
  '/v1/events/page': {
    get: secured({
      operationId: 'readEvents',
      parameters: [{ in: 'query', name: 'after', schema: { minimum: 0, type: 'integer' } }],
      responses: { 200: response('Bounded service event page') },
      tags: ['Events']
    })
  },
  '/v1/emulators': {
    get: secured({
      operationId: 'listEmulators',
      responses: { 200: response('Android emulator inventory', { items: reference('Emulator'), type: 'array' }) },
      tags: ['Emulators']
    })
  },
  '/v1/emulators/{emulatorId}:start': {
    post: secured({
      operationId: 'startEmulator',
      parameters: [idParameter('emulatorId', 'Android emulator id'), ...mutationHeaders],
      requestBody: actionBodyReference('EmulatorStartRequest'),
      responses: { 200: response('Android emulator start result', reference('Emulator')) },
      tags: ['Emulators']
    })
  },
  '/v1/emulators/{emulatorId}:restart': {
    post: secured({
      operationId: 'restartEmulator',
      parameters: [idParameter('emulatorId', 'Android emulator id'), ...mutationHeaders],
      requestBody: actionBodyReference('EmulatorStartRequest'),
      responses: { 200: response('Android emulator restart result', reference('Emulator')) },
      tags: ['Emulators']
    })
  },
  '/v1/emulators/{emulatorId}:stop': {
    post: secured({
      operationId: 'stopEmulator',
      parameters: [idParameter('emulatorId', 'Android emulator id'), ...mutationHeaders],
      requestBody: actionBodyReference('EmulatorStartRequest'),
      responses: { 200: response('Android emulator stop result', reference('Emulator')) },
      tags: ['Emulators']
    })
  },
  '/v1/inspectors': {
    get: { ...resourceListOperation('Inspectors', 'InspectorLease'), operationId: 'listInspectors' }
  },
  '/v1/inspectors/{inspectorId}': {
    get: secured({
      operationId: 'getInspector',
      parameters: [idParameter('inspectorId', 'Inspector lease id')],
      responses: { 200: response('Inspector lease', reference('InspectorLease')) },
      tags: ['Inspectors']
    })
  },
  '/v1/network-rules': {
    get: { ...resourceListOperation('Network rules', 'NetworkRules'), operationId: 'listNetworkRules' }
  },
  '/v1/network-rules/{networkRulesId}': {
    delete: secured({
      operationId: 'removeNetworkRules',
      parameters: [idParameter('networkRulesId', 'Network rules id'), ...mutationHeaders, revisionHeader],
      requestBody: actionBodyReference('ExpectedGenerationRequest'),
      responses: { 202: response('Network rules removal admitted') },
      tags: ['Network rules']
    }),
    get: secured({
      operationId: 'getNetworkRules',
      parameters: [idParameter('networkRulesId', 'Network rules id')],
      responses: { 200: response('Network rules', reference('NetworkRules')) },
      tags: ['Network rules']
    })
  },
  '/v1/operations': {
    get: { ...resourceListOperation('Operations', 'Operation'), operationId: 'listOperations' }
  },
  '/v1/operations/{operationId}': {
    get: secured({
      operationId: 'getOperation',
      parameters: [idParameter('operationId', 'Operation id')],
      responses: { 200: response('Operation', reference('Operation')) },
      tags: ['Operations']
    })
  },
  '/v1/service': {
    get: secured({
      operationId: 'getServiceStatus',
      responses: { 200: response('Service status') },
      tags: ['Control']
    })
  },
  '/v1/service:shutdown': {
    post: secured({
      operationId: 'shutdownService',
      parameters: mutationHeaders,
      requestBody: actionBodyReference('ServiceShutdownRequest'),
      responses: { 202: response('Service shutdown accepted') },
      tags: ['Control']
    })
  },
  '/v1/service/token:rotate': {
    post: secured({
      operationId: 'rotateServiceToken',
      parameters: mutationHeaders,
      requestBody: actionBodyReference('ServiceTokenRotateRequest'),
      responses: { 200: response('Service token rotated') },
      tags: ['Control']
    })
  },
  '/v1/skills': {
    get: secured({
      operationId: 'listServiceSkills',
      responses: { 200: response('Machine-readable service skill manifest') },
      tags: ['Skills']
    })
  }
}
