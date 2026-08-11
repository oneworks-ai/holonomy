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

const processAction = (action, operationId) =>
  secured({
    operationId,
    parameters: [idParameter('processId', 'Runtime process id'), ...mutationHeaders],
    requestBody: actionBodyReference('ExpectedGenerationRequest'),
    responses: { 202: response(`Process ${action} admitted`, reference('ProcessAdmission')) },
    tags: ['Processes']
  })

export const OPENAPI_PROCESS_PATHS = {
  '/v1/processes': {
    get: { ...resourceListOperation('Processes', 'Process'), operationId: 'listProcesses' },
    post: secured({
      operationId: 'startProcess',
      parameters: mutationHeaders,
      requestBody: actionBodyReference('ProcessStartRequest'),
      responses: { 202: response('Process start admitted', reference('ProcessAdmission')) },
      tags: ['Processes']
    })
  },
  '/v1/processes/{processId}': {
    delete: secured({
      operationId: 'deleteProcess',
      parameters: [idParameter('processId', 'Runtime process id'), ...mutationHeaders],
      requestBody: actionBodyReference('ExpectedGenerationRequest'),
      responses: { 200: response('Terminal process removed', reference('ProcessRemoval')) },
      tags: ['Processes']
    }),
    get: secured({
      operationId: 'getProcess',
      parameters: [idParameter('processId', 'Runtime process id')],
      responses: { 200: response('Runtime process', reference('Process')) },
      tags: ['Processes']
    })
  },
  '/v1/processes/{processId}/inspector-leases': {
    get: secured({
      operationId: 'listProcessInspectorLeases',
      parameters: [idParameter('processId', 'Runtime process id')],
      responses: { 200: response('Process inspector leases', { items: reference('InspectorLease'), type: 'array' }) },
      tags: ['Inspectors']
    }),
    post: secured({
      operationId: 'openInspector',
      parameters: [idParameter('processId', 'Runtime process id'), ...mutationHeaders],
      requestBody: actionBodyReference('InspectorOpenRequest'),
      responses: { 202: response('Inspector lease admitted') },
      tags: ['Inspectors']
    })
  },
  '/v1/processes/{processId}/inspector-leases/{inspectorId}': {
    delete: secured({
      operationId: 'closeInspector',
      parameters: [
        idParameter('processId', 'Runtime process id'),
        idParameter('inspectorId', 'Inspector lease id'),
        ...mutationHeaders
      ],
      requestBody: actionBodyReference('ExpectedGenerationRequest'),
      responses: { 200: response('Closed inspector lease', reference('InspectorLease')) },
      tags: ['Inspectors']
    }),
    get: secured({
      operationId: 'getProcessInspectorLease',
      parameters: [
        idParameter('processId', 'Runtime process id'),
        idParameter('inspectorId', 'Inspector lease id')
      ],
      responses: { 200: response('Inspector lease', reference('InspectorLease')) },
      tags: ['Inspectors']
    })
  },
  '/v1/processes/{processId}/logs': {
    get: secured({
      operationId: 'readProcessLogs',
      parameters: [
        idParameter('processId', 'Runtime process id'),
        { in: 'query', name: 'after', schema: { minimum: 0, type: 'integer' } },
        { in: 'query', name: 'limit', schema: { maximum: 1024, minimum: 1, type: 'integer' } },
        { in: 'query', name: 'waitMs', schema: { maximum: 30000, minimum: 0, type: 'integer' } }
      ],
      responses: { 200: response('Bounded process log page') },
      tags: ['Processes']
    })
  },
  '/v1/processes/{processId}/events': {
    get: secured({
      operationId: 'followProcessEvents',
      parameters: [
        idParameter('processId', 'Runtime process id'),
        { in: 'query', name: 'after', schema: { minimum: 0, type: 'integer' } }
      ],
      responses: {
        200: {
          content: { 'text/event-stream': { schema: { type: 'string' } } },
          description: 'Cursor-addressed process events'
        }
      },
      tags: ['Events']
    })
  },
  '/v1/processes/{processId}/network/rules': {
    delete: secured({
      operationId: 'removeProcessNetworkRules',
      parameters: [idParameter('processId', 'Runtime process id'), ...mutationHeaders, revisionHeader],
      requestBody: actionBodyReference('ExpectedGenerationRequest'),
      responses: { 202: response('Network rules removal admitted') },
      tags: ['Network rules']
    }),
    get: secured({
      operationId: 'getProcessNetworkRules',
      parameters: [idParameter('processId', 'Runtime process id')],
      responses: { 200: response('Process network rules', { items: reference('NetworkRules'), type: 'array' }) },
      tags: ['Network rules']
    }),
    put: secured({
      operationId: 'replaceNetworkRules',
      parameters: [idParameter('processId', 'Runtime process id'), ...mutationHeaders, revisionHeader],
      requestBody: actionBodyReference('NetworkRulesReplaceRequest'),
      responses: { 202: response('Network rules admitted') },
      tags: ['Network rules']
    })
  },
  '/v1/processes/{processId}:restart': {
    post: processAction('restart', 'restartProcess')
  },
  '/v1/processes/{processId}:resume': {
    post: processAction('resume', 'resumeProcess')
  },
  '/v1/processes/{processId}:stop': {
    post: processAction('stop', 'stopProcess')
  }
}
