import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { STORAGE_LIMIT_MAXIMA_V2 } from '@holonomyjs/capability-storage/kernel/storage-policy'

import { createServiceCapabilityRuntimeManagerV1 } from '../../../../tools/service/capability-runtime-manager.mjs'
import { compileSandboxPolicy } from '../../../../tools/service/sandbox-policy.mjs'

const entryUrl = 'fixture+storage://runtime/entry.mjs'
const suiteUrl = 'fixture+storage://runtime/suite.mjs'
const entry =
  `import './suite.mjs'; import { run } from 'node:test'; console.log('STORAGE_JS_SUMMARY:' + JSON.stringify(await run()));`
const suite = readFileSync(
  new URL('../../../../conformance/capabilities/storage-kv-v1.test.mjs', import.meta.url),
  'utf8'
)
const legacy =
  compileSandboxPolicy({ schemaVersion: 1, filesystem: { access: 'none' }, network: { access: 'none' } }).policy
export const generateStorageFixture = async () => {
  const modules = [{ url: entryUrl, source: entry }, { url: suiteUrl, source: suite }]
  const launch = { entryUrl, moduleRootUrl: 'fixture+storage://runtime/', modules, schemaVersion: 2, target: 'android' }
  const policy = {
    schemaVersion: 2,
    storage: {
      access: 'sandboxed',
      limits: { ...STORAGE_LIMIT_MAXIMA_V2, maxPendingOperations: 16, maxValueBytes: 4096 },
      namespaces: [{
        namespaceId: 'default',
        operations: ['storage.kv.get', 'storage.kv.set', 'storage.kv.list', 'storage.kv.delete'],
        keyPrefixes: ['allowed/'],
        databases: []
      }]
    }
  }
  const manager = createServiceCapabilityRuntimeManagerV1()
  const admitted = manager.admit({
    context: { schemaVersion: 1, guest: {}, host: {}, inspector: {} },
    initialMiddlewareId: 'service.continue.v1',
    sandboxPolicy: policy,
    schemaVersion: 1
  }, {
    entryUrl,
    inspectorMode: 'off',
    launch,
    sandboxPolicy: legacy,
    target: 'android'
  })
  const configurations = []
  for (const generation of [1, 2]) {
    configurations.push(
      await manager.prepare({
        capabilityRuntime: admitted,
        entryUrl,
        generation,
        id: 'android_storage_fixture',
        inspectorMode: 'off',
        launch,
        sandboxPolicy: legacy,
        target: 'android'
      })
    )
  }
  return { entryUrl, entry, suiteUrl, suite, configurations }
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = resolve(process.argv[2])
  void generateStorageFixture().then(fixture => {
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, JSON.stringify(fixture))
  }).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
