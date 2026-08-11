import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { admitLaunchSnapshot } from '../launch-admission.mjs'
import { HOLONOMY_SERVICE_OPENAPI } from '../openapi.mjs'
import { SERVICE_REQUEST_DIALECT, SERVICE_REQUEST_SCHEMAS, validateServiceRequest } from '../request-schemas.mjs'

describe('holonomy Service OpenAPI contract', () => {
  it('uses one Ajv 2020 schema source for OpenAPI and request admission', () => {
    assert.equal(HOLONOMY_SERVICE_OPENAPI.openapi, '3.1.0')
    for (const [name, schema] of Object.entries(SERVICE_REQUEST_SCHEMAS)) {
      assert.equal(schema.$schema, SERVICE_REQUEST_DIALECT)
      assert.equal(HOLONOMY_SERVICE_OPENAPI.components.schemas[name], schema)
    }

    assert.equal(validateServiceRequest('ExpectedGenerationRequest', { expectedGeneration: 1 }).expectedGeneration, 1)
    assert.throws(
      () => validateServiceRequest('ExpectedGenerationRequest', { expectedGeneration: 1, ignored: true }),
      error => error.code === 'service.invalid_request'
    )
    const processStart = validateServiceRequest('ProcessStartRequest', {
      deviceId: 'node:local',
      entryUrl: 'app+local://workspace/main.mjs',
      inspectorMode: 'off',
      isolation: 'runtime',
      launch: {
        entryUrl: 'app+local://workspace/main.mjs',
        moduleRootUrl: 'app+local://workspace/',
        modules: [{ source: 'export {}', url: 'app+local://workspace/main.mjs' }],
        schemaVersion: 2,
        target: 'node'
      },
      target: 'node'
    })
    assert.equal(processStart.launch.modules[0].url, processStart.entryUrl)
    assert.throws(
      () =>
        validateServiceRequest('ProcessStartRequest', {
          ...processStart,
          launch: { ...processStart.launch, modules: [] }
        }),
      error => error.code === 'service.invalid_request'
    )
    assert.deepEqual(
      admitLaunchSnapshot({
        entryUrl: 'app+local://workspace/.holonomy/entry.mjs',
        moduleRootUrl: 'app+local://workspace/',
        modules: [{ source: 'export {}', url: 'app+local://workspace/specs/example.mjs' }]
      }, {
        entryUrl: 'app+local://workspace/.holonomy/entry.mjs',
        target: 'node'
      }).moduleRootUrl,
      'app+local://workspace/'
    )
    assert.throws(
      () =>
        admitLaunchSnapshot({
          moduleRootUrl: 'app+local://workspace/.holonomy/',
          modules: [{ source: 'export {}', url: 'app+local://workspace/specs/example.mjs' }]
        }, {
          entryUrl: 'app+local://workspace/.holonomy/entry.mjs',
          target: 'node'
        }),
      error => error.code === 'service.invalid_request'
    )
    assert.equal(
      admitLaunchSnapshot({
        moduleRootUrl: 'file:///workspace/',
        modules: [{ source: 'export {}', url: 'file:///workspace/specs/example.mjs' }]
      }, {
        entryUrl: 'file:///workspace/.holonomy/entry.mjs',
        target: 'node'
      }).moduleRootUrl,
      'file:///workspace/'
    )
    for (
      const moduleRootUrl of [
        'app+local://workspace/a%2Fb/',
        'app+local://workspace/a%5Cb/',
        'app+local://workspace/a%00b/',
        'app+local://workspace/a%xx/',
        'app+local://workspace/a\\b/',
        `app+local://workspace/a\0b/`
      ]
    ) {
      assert.throws(
        () =>
          admitLaunchSnapshot({ moduleRootUrl }, {
            entryUrl: 'app+local://workspace/a/main.mjs',
            target: 'node'
          }),
        error => error.code === 'service.invalid_request'
      )
    }
    for (
      const [moduleRootUrl, entryUrl] of [
        ['data:text/plain,root/', 'data:text/plain,root/main.mjs'],
        ['mailto:user@example.com/', 'mailto:user@example.com/main.mjs']
      ]
    ) {
      assert.throws(
        () => admitLaunchSnapshot({ moduleRootUrl }, { entryUrl, target: 'node' }),
        error => error.code === 'service.invalid_request'
      )
    }
    assert.throws(
      () =>
        admitLaunchSnapshot({
          moduleRootUrl: 'app+local://workspace/specs/',
          modules: [{ source: 'export {}', url: 'app+local://workspace/specs-other/example.mjs' }]
        }, {
          entryUrl: 'app+local://workspace/specs/main.mjs',
          target: 'node'
        }),
      error => error.code === 'service.invalid_request'
    )
    assert.throws(
      () =>
        admitLaunchSnapshot({
          moduleRootUrl: 'app+local://workspace/',
          modules: [{ source: 'export {}', url: 'app+local://other/specs/example.mjs' }]
        }, {
          entryUrl: 'app+local://workspace/main.mjs',
          target: 'node'
        }),
      error => error.code === 'service.invalid_request'
    )
    assert.throws(
      () =>
        validateServiceRequest('ProcessStartRequest', {
          deviceId: 'node:local',
          entryUrl: 'app+local://workspace/main.mjs',
          inspectorMode: 'off',
          isolation: 'runtime',
          launch: { networkAuthority: { allowedOrigins: ['https://guest.invalid'] } },
          target: 'node'
        }),
      error => error.code === 'service.invalid_request'
    )
    assert.throws(
      () =>
        validateServiceRequest('ProcessStartRequest', {
          deviceId: 'node:local',
          entryUrl: 'app+local://workspace/main.mjs',
          fixture: { kind: 'conformance-network-v1' },
          inspectorMode: 'off',
          isolation: 'runtime',
          launch: { fixture: { kind: 'conformance-network-v1' } },
          target: 'node'
        }),
      error => error.code === 'service.invalid_request'
    )
    assert.throws(
      () =>
        validateServiceRequest('ProcessStartRequest', {
          deviceId: 'node:local',
          entryUrl: 'app+local://workspace/main.mjs',
          inspectorMode: 'enabled',
          isolation: 'runtime',
          launch: {},
          target: 'node',
          token: 'guest-controlled'
        }),
      error => error.code === 'service.invalid_request'
    )
  })

  it('has unique operation ids and component-backed mutation bodies', () => {
    const operations = Object.values(HOLONOMY_SERVICE_OPENAPI.paths)
      .flatMap(path => Object.values(path))
      .filter(operation => operation != null && typeof operation === 'object' && operation.operationId != null)
    assert.equal(new Set(operations.map(operation => operation.operationId)).size, operations.length)
    assert.deepEqual(
      HOLONOMY_SERVICE_OPENAPI.paths['/v1/processes'].post.requestBody.content['application/json'].schema,
      { $ref: '#/components/schemas/ProcessStartRequest' }
    )
    assert.deepEqual(
      HOLONOMY_SERVICE_OPENAPI.paths['/v1/processes'].post.responses[202].content['application/json'].schema,
      { $ref: '#/components/schemas/ProcessAdmission' }
    )
    assert.equal(HOLONOMY_SERVICE_OPENAPI.components.schemas.Process.additionalProperties, false)
    assert.ok(HOLONOMY_SERVICE_OPENAPI.components.schemas.Process.required.includes('sandboxPolicyState'))
    assert.equal(HOLONOMY_SERVICE_OPENAPI.components.schemas.Process.properties.launch, undefined)
    assert.ok(HOLONOMY_SERVICE_OPENAPI.paths['/v1/processes/{processId}/network/rules'])
    assert.ok(HOLONOMY_SERVICE_OPENAPI.paths['/v1/processes/{processId}/inspector-leases'])
    assert.ok(HOLONOMY_SERVICE_OPENAPI.paths['/v1/processes/{processId}/inspector-leases/{inspectorId}'])
    assert.ok(
      HOLONOMY_SERVICE_OPENAPI.paths['/v1/processes/{processId}/events'].get.responses[200]
        .content['text/event-stream']
    )
    assert.ok(
      HOLONOMY_SERVICE_OPENAPI.components.schemas.Error.properties.error.properties.code.enum
        .includes('process.isolation_unsupported')
    )
    assert.ok(
      HOLONOMY_SERVICE_OPENAPI.components.schemas.Error.properties.error.properties.code.enum
        .includes('sandbox.capability_unsupported')
    )
  })
})
