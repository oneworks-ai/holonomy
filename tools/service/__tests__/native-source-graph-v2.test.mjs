import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { createHolonomyService } from '../server.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const token = 'native-source-root-test-token-at-least-thirty-two-bytes'
const until = async (read, accepts) => {
  for (let turn = 0; turn < 500; turn++) {
    const value = await read()
    if (accepts(value)) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Native workspace launch did not settle')
}
const run = async (entryUrl, modules, expected) => {
  const root = await mkdtemp(join(tmpdir(), 'holo-native-root-v2-'))
  const service = createHolonomyService({ nativeExecutablePath: binary, port: 0, stateDirectory: root, token })
  try {
    await service.start()
    const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
    await client.call('/v1/devices:refresh', { body: {}, method: 'POST' })
    const admitted = await client.launchProcess({
      deviceId: 'native:local',
      entryUrl,
      inspectorMode: 'off',
      isolation: 'runtime',
      launch: {
        argv: [entryUrl, 'argument'],
        command: 'run',
        entryUrl,
        moduleRootUrl: 'app://workspace/',
        modules,
        reporter: 'tap',
        schemaVersion: 2,
        target: 'native'
      },
      target: 'native'
    }, 'root-v2-launch')
    const id = admitted.value.process.id
    const operation = await until(
      () => client.getOperation(admitted.value.operation.id),
      value => ['succeeded', 'failed'].includes(value.state)
    )
    const ended = await until(
      () => client.getProcess(id),
      value => ['exited', 'failed'].includes(value.state)
    )
    const page = await until(
      () => client.readLogs(id, { after: 0, limit: 256 }),
      value => value.events.length > 0
    )
    const text = page.events.map(event => event.chunk).join('')
    assert.equal(operation.state, 'succeeded', text)
    assert.equal(ended.exit.code, 0, text)
    assert(text.includes(expected), text)
    await client.removeProcess(id, ended.generation, 'root-v2-remove')
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
}

describe('native source workspace and logical query identities', () => {
  it.skipIf(binary == null)('keeps a nested CommonJS entry as the actual main with root package lookup', async () => {
    const main = 'app://workspace/src/main.cjs'
    await run(main, [
      {
        url: main,
        source: [
          "const assert=require('node:assert/strict');",
          "assert.strictEqual(require.main,module);assert.equal(module.id,'.');",
          `assert.equal(module.filename,${JSON.stringify(main)});`,
          `assert.equal(process.argv[1],${JSON.stringify(main)});`,
          "assert.equal(process.argv[2],'argument');",
          "assert.equal(require('physical-pkg'),42);console.log('NATIVE_NESTED_MAIN_OK');"
        ].join('\n')
      },
      { url: 'app://workspace/package.json', source: '{"type":"commonjs"}' },
      {
        url: 'app://workspace/node_modules/physical-pkg/package.json',
        source: '{"exports":{".":{"import":"./index.mjs","require":"./index.cjs"}}}'
      },
      { url: 'app://workspace/node_modules/physical-pkg/index.cjs', source: 'module.exports=42' }
    ], 'NATIVE_NESTED_MAIN_OK')
  }, 15_000)

  it.skipIf(binary == null)('stages one file for two query identities but evaluates distinct modules', async () => {
    const source = 'globalThis.instances=(globalThis.instances??0)+1;export const id=globalThis.instances;'
    await run('app://workspace/index.mjs', [
      {
        url: 'app://workspace/index.mjs',
        source:
          "import {id as a} from './dep.mjs?one';import {id as b} from './dep.mjs?two';if(a+b!==3)throw Error('query cache');console.log('NATIVE_QUERY_IDENTITIES_OK');"
      },
      { url: 'app://workspace/dep.mjs?one', source },
      { url: 'app://workspace/dep.mjs?two', source }
    ], 'NATIVE_QUERY_IDENTITIES_OK')
  }, 15_000)
})
