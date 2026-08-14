import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, it } from 'vitest'

// eslint-disable-next-line antfu/no-import-dist -- Service production consumes the built Runtime contract.
import { DEFAULT_SANDBOX_POLICY_V2 } from '../../../dist/capability-runtime/index.js'
import { HolonomyControlCore } from '../control-core.mjs'
import { createNodeRuntimeAdapter } from '../node-target-adapter.mjs'
import { publicProcessDto } from '../public-process-dto.mjs'
import { ServiceLogStore } from '../service-log-store.mjs'
import { AtomicServiceStateStore } from '../state-store.mjs'
import { createTargetAdapterDispatcher } from '../target-adapters.mjs'

const entryUrl = 'app+local://workspace/main.mjs'
const processProfile = {
  backend: {
    backendId: 'native.darwin-seatbelt-v1',
    configuration: {
      runtimeReadPaths: ['/opt/homebrew'],
      sandboxExecutablePath: '/usr/bin/sandbox-exec'
    }
  },
  environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
  executables: [{
    executableId: 'node-helper',
    executablePath: process.execPath,
    fixedArgs: [],
    shell: false
  }],
  profile: 'process-profile-v1'
}

const processPolicy = () => {
  const policy = structuredClone(DEFAULT_SANDBOX_POLICY_V2)
  policy.process = {
    access: 'sandboxed',
    environment: { allowedNames: [], maxValueBytes: 1024 },
    executables: [{ argumentBytes: 64 * 1024, executableId: 'node-helper' }],
    limits: {
      maxConcurrentProcesses: 2,
      maxExecutionTimeMs: 5000,
      maxOpenPipes: 6,
      maxProcessTreeDepth: 1,
      maxStderrBytes: 64 * 1024,
      maxStdinBytes: 64 * 1024,
      maxStdoutBytes: 64 * 1024,
      maxTotalProcesses: 4,
      maxWritableRootfsBytes: 0
    },
    mounts: [],
    network: { access: 'none' },
    shell: { access: 'none' }
  }
  return policy
}

const request = (source, profileId = 'developer') => ({
  capabilityRuntime: {
    context: {
      guest: { application: { id: 'process.example', name: 'Process Example' } },
      host: { tenantId: 'private-tenant' },
      inspector: { title: 'Process Example' },
      schemaVersion: 1
    },
    initialMiddlewareId: 'service.continue.v1',
    processProfileId: profileId,
    sandboxPolicy: processPolicy(),
    schemaVersion: 1
  },
  deviceId: 'node:local',
  entryUrl,
  inspectorMode: 'off',
  isolation: 'runtime',
  launch: {
    entryUrl,
    moduleRootUrl: 'app+local://workspace/',
    modules: [{ source, url: entryUrl }],
    schemaVersion: 2,
    target: 'node'
  },
  sandboxPolicy: {
    filesystem: { access: 'none' },
    network: { access: 'none' },
    schemaVersion: 1
  },
  target: 'node'
})

const waitForOperation = async (core, id) => {
  for (let turn = 0; turn < 2_000; turn += 1) {
    const operation = core.get('operations', id, 'Operation')
    if (['cancelled', 'failed', 'succeeded'].includes(operation.state)) return operation
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('Process profile operation did not settle')
}

describe('service native Process profile', () => {
  it.skipIf(process.platform !== 'darwin')(
    'resolves one Host-only profile id before entry without exposing native paths',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-process-profile-'))
      const core = new HolonomyControlCore({
        adapterDispatcher: createTargetAdapterDispatcher({ node: createNodeRuntimeAdapter() }),
        capabilityProcessProfiles: { developer: processProfile },
        deviceRefreshIntervalMs: 60_000,
        logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
        outputPollIntervalMs: 5,
        stateDirectory: directory,
        store: new AtomicServiceStateStore({ directory })
      })
      try {
        await core.open()
        await core.refreshDevices()
        const admission = await core.startProcess(
          request(`
          import { childProcessEnvironment } from 'holo:runtime'
          import { execFileSync } from 'node:child_process'
          const output = execFileSync('node-helper', ['-e', 'process.stdout.write("service-process-ok")'], {
            [childProcessEnvironment]: { scope: 'processTree' },
            encoding: 'utf8'
          })
          console.log('M35_SERVICE_PROCESS:' + output)
        `),
          'service-process-profile'
        )
        assert.equal((await waitForOperation(core, admission.value.operation.id)).state, 'succeeded')
        const processRecord = core.get('processes', admission.value.process.id, 'Runtime process')
        const page = await core.readLogs(processRecord.id, { after: 0, waitMs: 1000 })
        assert.ok(page.events.some(event => event.chunk === 'M35_SERVICE_PROCESS:service-process-ok'))
        const serialized = JSON.stringify(publicProcessDto(processRecord))
        for (const secret of ['/opt/homebrew', '/usr/bin/sandbox-exec', process.execPath]) {
          assert.equal(serialized.includes(secret), false)
        }
      } finally {
        await core.close()
        await rm(directory, { force: true, recursive: true })
      }
    },
    30_000
  )

  it('rejects an unavailable Backend before creating a Runtime process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-service-process-missing-'))
    const core = new HolonomyControlCore({
      adapterDispatcher: createTargetAdapterDispatcher({ node: createNodeRuntimeAdapter() }),
      deviceRefreshIntervalMs: 60_000,
      logStore: new ServiceLogStore({ directory: join(directory, 'logs') }),
      stateDirectory: directory,
      store: new AtomicServiceStateStore({ directory })
    })
    try {
      await core.open()
      await core.refreshDevices()
      await assert.rejects(
        core.startProcess(request('console.log("ENTRY_SIDE_EFFECT")'), 'missing-process-profile'),
        error => error.code === 'sandbox.capability_unsupported'
      )
      assert.equal(core.list('processes').length, 0)
    } finally {
      await core.close()
      await rm(directory, { force: true, recursive: true })
    }
  })
})
