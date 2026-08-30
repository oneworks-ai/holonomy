import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { prepareHolonomyRuntimePlugins } from '../../holonomy-plugin-bundle.mjs'
import { startHolonomyPluginWatch } from '../../holonomy-plugin-watch.mjs'
import { createHolonomyService } from '../server.mjs'
import { createHolonomyServiceClient } from '../service-client.mjs'

const token = 'plugin-watch-e2e-token-at-least-thirty-two-bytes'
const entryUrl = 'app+local://workspace/main.mjs'

const policy = () => ({
  device: {
    defaultAccess: 'deny',
    maxEventsPerSecond: 1,
    maxQueuedEvents: 0,
    maxSubscriptions: 0,
    operations: {}
  },
  filesystem: { access: 'none' },
  schemaVersion: 2,
  systemInformation: {
    defaultMode: 'unavailable',
    fields: { 'os.arch': { allowedModes: ['synthetic'], maxPrecision: 'exact' } }
  }
})

const waitForOperation = async (client, id, processId) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const operation = await client.getOperation(id)
    if (operation.state === 'succeeded') return operation
    if (!['queued', 'running'].includes(operation.state)) {
      const logs = processId == null ? undefined : await client.readLogs(processId, { limit: 512 })
      assert.fail(`${JSON.stringify(operation)}\n${JSON.stringify(logs)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`Operation did not settle: ${id}`)
}

const waitFor = async (read, predicate, label) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`Timed out waiting for ${label}`)
}

const config = deny =>
  JSON.stringify({
    plugins: [{ config: { deny }, id: 'permission', use: './permission.mjs' }]
  })

describe('node CLI Runtime plugin watch integration', () => {
  it('applies a real Service graph transaction and retains the last-known-good graph', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-plugin-watch-e2e-'))
    const configPath = join(directory, 'holo.config.json')
    const pluginPath = join(directory, 'permission.mjs')
    const diagnostics = []
    await writeFile(
      pluginPath,
      `import { createHoloPermissionPluginV1 } from '@holonomyjs/plugin-permission'
      export default createHoloPermissionPluginV1({
        decide: ({ pluginConfig }) => pluginConfig.deny ? 'deny' : 'allow',
        execution: 'sync',
        matcher: { operation: 'system.os.arch.read' }
      })`
    )
    await writeFile(configPath, config(false))
    const initial = prepareHolonomyRuntimePlugins(configPath).bundles
    const service = createHolonomyService({ port: 0, stateDirectory: join(directory, 'state'), token })
    let watcher
    try {
      await service.start()
      const client = createHolonomyServiceClient({ baseUrl: service.baseUrl, token })
      await client.call('/v1/devices:refresh', { body: {}, method: 'POST' })
      const started = await client.launchProcess({
        capabilityRuntime: {
          context: { schemaVersion: 1 },
          initialMiddlewareId: 'service.continue.v1',
          sandboxPolicy: policy(),
          schemaVersion: 1
        },
        deviceId: 'node:local',
        entryUrl,
        inspectorMode: 'off',
        isolation: 'runtime',
        launch: {
          argv: [entryUrl],
          command: 'run',
          entryUrl,
          env: {},
          moduleRootUrl: 'app+local://workspace/',
          modules: [{
            source: `
              import { arch } from 'node:os'
              setInterval(() => {
                try { console.log('WATCH_ARCH:' + arch()) }
                catch (error) { console.log('WATCH_DENY:' + error.code) }
              }, 20)
            `,
            url: entryUrl
          }],
          reporter: 'tap',
          schemaVersion: 2,
          target: 'node'
        },
        runtimePlugins: initial,
        sandboxPolicy: { filesystem: { access: 'none' }, network: { access: 'none' }, schemaVersion: 1 },
        target: 'node'
      }, 'plugin-watch-start')
      await waitForOperation(client, started.value.operation.id, started.value.process.id)
      const process = await client.getProcess(started.value.process.id)
      watcher = startHolonomyPluginWatch({
        client,
        configPath,
        dependencies: { waitForOperation: (watchClient, id) => waitForOperation(watchClient, id) },
        io: { stderr: { write: value => diagnostics.push(value) } },
        pluginRoots: [],
        process,
        runtimePlugins: initial
      })
      let cursor = 0
      let observedLogs = ''
      const logs = async () => {
        const page = await client.readLogs(process.id, { after: cursor, limit: 512, waitMs: 5 })
        cursor = page.cursor
        observedLogs += page.events.map(event => event.chunk).join('')
        return observedLogs
      }
      await waitFor(logs, value => value.includes('WATCH_ARCH:'), 'initial allowed invocation')

      await writeFile(configPath, config(true))
      await waitFor(() => client.getProcess(process.id), value => value.pluginGraphRevision === 2, 'revision 2')
      await waitFor(logs, value => value.includes('WATCH_DENY:'), 'denied invocation')
      assert.match(observedLogs, /WATCH_DENY:(?:EACCES|ERR_ACCESS_DENIED)/u)

      await writeFile(configPath, '{"plugins":[')
      await new Promise(resolve => setTimeout(resolve, 250))
      assert.equal((await client.getProcess(process.id)).pluginGraphRevision, 2)

      await writeFile(configPath, config(false))
      await waitFor(() => client.getProcess(process.id), value => value.pluginGraphRevision === 3, 'revision 3')
      await waitFor(logs, value => value.includes('WATCH_ARCH:'), 'restored allowed invocation')
      assert.ok(diagnostics.some(value => value.includes('candidate was rejected')))
    } finally {
      await watcher?.close()
      await service.close()
      await rm(directory, { force: true, recursive: true })
    }
  }, 30_000)
})
