import assert from 'node:assert/strict'
import { once } from 'node:events'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { createNodeEnvironmentProcessBackendV1 } from '../src/capability-process-environment-backend.mjs'

const descriptor = {
  backendId: 'experimental.fixture-environment-v1',
  binaryFormats: ['linux-x86-32'],
  environmentScopes: ['runtime', 'processTree'],
  family: 'virtual-machine',
  features: {
    filesystemBridge: true,
    networkBridge: false,
    pty: false,
    shell: true,
    signals: true,
    snapshots: true,
    synchronousSpawn: false
  },
  platforms: ['desktop', 'node'],
  stability: 'experimental',
  version: 1
}

const launch = (backend, scope, generation = 7) =>
  backend.prepareLaunch({
    configuration: { imageId: 'fixture' },
    environmentScope: scope,
    executable: { kind: 'guestPath', path: '/bin/tool' },
    executableId: 'tool',
    generation,
    policy: { access: 'sandboxed' },
    runtimeArgs: ['--fixture']
  })

const spawn = (backend, value, id) =>
  backend.spawn(value, {
    cwd: value.cwd,
    env: { LANG: 'C' },
    stdio: ['pipe', 'pipe', 'pipe']
  }, { processResourceId: id })

const fixtureBackend = () => {
  const closed = []
  const opened = []
  const requests = []
  const backend = createNodeEnvironmentProcessBackendV1({
    descriptor,
    environmentFactory: {
      async open(request) {
        opened.push(request)
        return {
          async close(reason) {
            closed.push([request.environmentId, reason])
          },
          async spawn(input, sink) {
            requests.push(input)
            const timer = setTimeout(() => {
              sink.stdout(Uint8Array.from([0x6F, 0x6B]))
              sink.exit(0, null)
              sink.close(0, null)
            }, 0)
            return {
              async closeStdin() {},
              async signal() {
                clearTimeout(timer)
                sink.exit(null, 'SIGKILL')
                sink.close(null, 'SIGKILL')
              },
              async writeStdin() {}
            }
          }
        }
      }
    },
    normalizeConfiguration: value => Object.freeze({ ...value }),
    normalizeExecutable: value => Object.freeze({ ...value })
  })
  return { backend, closed, opened, requests }
}

test('reuses a runtime environment and closes it with its generation', async () => {
  const fixture = fixtureBackend()
  const first = spawn(fixture.backend, launch(fixture.backend, 'runtime'), 'process-1')
  const second = spawn(fixture.backend, launch(fixture.backend, 'runtime'), 'process-2')
  const firstOutput = []
  first.child.stdout.on('data', chunk => firstOutput.push(chunk.toString()))
  await Promise.all([once(first.child, 'close'), once(second.child, 'close')])

  assert.equal(fixture.opened.length, 1)
  assert.deepEqual(firstOutput, ['ok'])
  assert.deepEqual(fixture.requests.map(item => item.processResourceId), ['process-1', 'process-2'])
  assert.deepEqual(fixture.closed, [])
  await fixture.backend.closeGeneration(7)
  assert.deepEqual(fixture.closed, [['7:runtime', 'generation-stale']])
})

test('owns one processTree environment per root process', async () => {
  const fixture = fixtureBackend()
  const first = spawn(fixture.backend, launch(fixture.backend, 'processTree'), 'process-1')
  const second = spawn(fixture.backend, launch(fixture.backend, 'processTree'), 'process-2')
  await Promise.all([once(first.child, 'close'), once(second.child, 'close')])
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(fixture.opened.length, 2)
  assert.deepEqual(fixture.closed, [
    ['7:processTree:process-1', 'process-complete'],
    ['7:processTree:process-2', 'process-complete']
  ])
})
