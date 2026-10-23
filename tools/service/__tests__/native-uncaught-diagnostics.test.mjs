import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { createHolonomyService } from '../server.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const token = 'native-uncaught-test-token-at-least-thirty-two-bytes'
const entryUrl = 'app://workspace/main.mjs'
const until = async (read, accepts) => {
  for (let turn = 0; turn < 500; turn++) {
    const value = await read()
    if (accepts(value)) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Native diagnostic Service state did not settle')
}
const input = source => ({
  deviceId: 'native:local',
  entryUrl,
  inspectorMode: 'off',
  isolation: 'runtime',
  launch: {
    argv: [entryUrl],
    command: 'run',
    entryUrl,
    moduleRootUrl: 'app://workspace/',
    modules: [{ source, url: entryUrl }],
    reporter: 'tap',
    schemaVersion: 2,
    target: 'native'
  },
  target: 'native'
})

const cases = [
  {
    name: 'entry Error with hostile stack getter',
    source: [
      "const error=new Error('NATIVE_ENTRY_MESSAGE');",
      "Object.defineProperty(error,'stack',{get(){console.log('FORMAT_SIDE_EFFECT:stack');return 'FORGED_HOST_STACK:/private/secret'}});",
      "console.log('BEFORE_THROW');throw error;"
    ].join('\n'),
    message: 'NATIVE_ENTRY_MESSAGE'
  },
  {
    name: 'unhandled rejection with forged stack',
    source: [
      "const error=new Error('NATIVE_REJECTION_MESSAGE');",
      "error.stack='FORGED_HOST_STACK:/private/secret';",
      "Error.prepareStackTrace=()=>{console.log('FORMAT_SIDE_EFFECT:prepare');return 'FORGED_HOST_STACK'};",
      "console.log('BEFORE_THROW');Promise.reject(error);"
    ].join('\n'),
    message: 'NATIVE_REJECTION_MESSAGE'
  },
  {
    name: 'unhandled Proxy rejection',
    source: [
      'const handler={};',
      "for(const name of ['get','getPrototypeOf','getOwnPropertyDescriptor','ownKeys','isExtensible'])",
      "handler[name]=(...args)=>{console.log('FORMAT_SIDE_EFFECT:'+name);return Reflect[name](...args)};",
      "console.log('BEFORE_THROW');Promise.reject(new Proxy(new Error('HIDDEN_PROXY_MESSAGE'),handler));"
    ].join('\n')
  }
]

describe('real Native uncaught diagnostics through Service logs', () => {
  for (const example of cases) {
    it.skipIf(binary == null)(example.name, async () => {
      const root = await mkdtemp(join(tmpdir(), 'holo-native-uncaught-service-'))
      const service = createHolonomyService({
        nativeExecutablePath: binary,
        port: 0,
        stateDirectory: join(root, 'state'),
        token
      })
      try {
        await service.start()
        const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
        await client.call('/v1/devices:refresh', { body: {}, method: 'POST' })
        const admitted = await client.launchProcess(input(example.source), 'native-diagnostic-start')
        const id = admitted.value.process.id
        await until(
          () => client.getOperation(admitted.value.operation.id),
          operation => ['succeeded', 'failed'].includes(operation.state)
        )
        const ended = await until(
          () => client.getProcess(id),
          runtime => ['exited', 'failed'].includes(runtime.state)
        )
        assert.equal(ended.exit.code, 1)
        const page = await until(
          () => client.readLogs(id, { after: 0, limit: 256 }),
          logs => logs.events.some(event => event.stream === 'stderr')
        )
        const text = page.events.map(event => event.chunk).join('')
        assert(text.includes('BEFORE_THROW'), text)
        if (example.message != null) assert(text.includes(example.message), text)
        assert(!text.includes('FORMAT_SIDE_EFFECT'), text)
        assert(!text.includes('FORGED_HOST_STACK'), text)
        assert(!text.includes('HIDDEN_PROXY_MESSAGE'), text)
        assert(!text.includes('/Users/'), text)
        await client.removeProcess(id, ended.generation, 'native-diagnostic-remove')
      } finally {
        await service.close()
        await rm(root, { recursive: true, force: true })
      }
    }, 15_000)
  }
})
