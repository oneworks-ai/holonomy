import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { CHILD_PROCESS_CAPABILITY_MATRIX, RuntimeEventLoop, createHolonomyRuntime } from '../../../src/index.js'
import type { HostEventLoopPort, NativePort } from '../../../src/index.js'

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/android-m2-consumers')
const fixtureNames = [
  'managed-plugin-git.mjs',
  'relay-websocket.mjs',
  'workspace-fs.mjs',
  'workspace-http.mjs'
] as const
const fixtureSources = new Map(
  fixtureNames.map(name => [`app:///consumers/${name}`, readFileSync(resolve(fixtureRoot, name))])
)

const host = (): HostEventLoopPort => ({
  checkpointMicrotasks() {},
  now: () => 0,
  requestWakeup() {},
  terminate() {}
})

const port = (): NativePort => ({
  cancel() {},
  closeResource() {},
  dispatch() {},
  dispose() {},
  grantCredits() {}
})

const nodeCore = () => ({
  os: {
    arch: 'arm64',
    homedir: '/runtime/home',
    hostname: 'runtime',
    identityPolicy: 'synthetic' as const,
    platform: 'android',
    release: '35',
    tmpdir: '/runtime/tmp',
    type: 'Mobile',
    userInfo: { gid: 1, homedir: '/runtime/home', shell: null, uid: 1, username: 'runtime' }
  },
  process: {
    arch: 'arm64',
    argv: [],
    cwd: '/runtime',
    env: {},
    execPath: '/runtime/node',
    pid: 1,
    platform: 'android',
    versions: { node: '22' }
  },
  stdio: { write: () => true },
  virtualRoot: '/runtime'
})

const createBaseRuntime = async () => {
  const eventLoop = new RuntimeEventLoop(host())
  const runtime = await createHolonomyRuntime({
    authority: { capabilities: [], principal: 'android-m2-fixture' },
    eventLoop,
    moduleLoader: {
      readModule: canonicalUrl => {
        const bytes = fixtureSources.get(canonicalUrl)
        return bytes == null
          ? null
          : {
            bytes: new Uint8Array(bytes),
            sha256: createHash('sha256').update(bytes).digest('hex')
          }
      },
      rootUrl: 'app:///consumers/'
    },
    nativePort: port(),
    nodeCore: nodeCore()
  })
  return { eventLoop, runtime }
}

describe('android M2 provenance-pinned consumer boundaries', () => {
  it('pins the source revision and content digests used to shape fixtures', () => {
    const provenance = JSON.parse(
      readFileSync(resolve(fixtureRoot, 'provenance.json'), 'utf8')
    ) as {
      fixtures: Record<string, { extraction: string; sha256: string; source: string; transform: string }>
      sourceMainTask: string
      sourceRevision: string
      sources: Record<string, { path: string; sha256: string; surface: string }>
    }

    expect(provenance.sourceMainTask).toBe('019fe11a-4aaa-7733-9173-2867a9a65777')
    expect(provenance.sourceRevision).toBe('ea3159294ce2c69a7d14dbdc3d4d4b1a1335396e')
    expect(Object.keys(provenance.fixtures).sort()).toEqual([...fixtureNames].sort())
    for (const fixture of fixtureNames) {
      const bytes = readFileSync(resolve(fixtureRoot, fixture))
      const record = provenance.fixtures[fixture]
      expect(record.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(record.extraction.length).toBeGreaterThan(80)
      expect(record.transform.length).toBeGreaterThan(80)
      expect(provenance.sources[record.source]).toBeDefined()
    }
    expect(provenance.sources).toEqual({
      managedPluginGit: {
        path: 'packages/plugins/relay/src/config.ts',
        sha256: '545c24415a8344ab22e7cb8bfdb465dcf93606f8a4979d32a93a3686e96c9d30',
        surface: "execFile('git', ['-C', workspaceFolder, 'config', '--get-regexp', '^remote\\..*\\.url$'], callback)"
      },
      relayWebSocket: {
        path: 'packages/plugins/relay/src/server/workspace-websocket-forwarder.ts',
        sha256: 'c221ab4407fdc8cce1ee0553a0b44a0e2d01d57e3b7fe29b2f4020fa5d9af4a4',
        surface: 'default ws client with open/message/close/error lifecycle'
      },
      workspaceFs: {
        path: 'apps/server/src/routes/workspace.ts',
        sha256: '8ac45f8386e0aa074911235a00f37361ee015a83a2efd4b45084d0d40700b089',
        surface: 'node:fs createReadStream plus workspace file/tree routes'
      },
      workspaceHttp: {
        path: 'packages/plugins/relay/src/server/workspace-http-forwarder.ts',
        sha256: '674792f8e3df23d59b2d50f394d540d0b45095993179a6f720288eef9c397bd4',
        surface: 'node:buffer + node:process + fetch + AbortController + timer'
      }
    })
  })

  it('plans the workspace HTTP imports but records unavailable Android I/O', async () => {
    const { eventLoop, runtime } = await createBaseRuntime()
    try {
      const plan = await runtime.moduleLoader!.createPlan('./workspace-http.mjs')
      expect(plan.modules.map(module => [module.url, module.format])).toEqual([
        ['app:///consumers/workspace-http.mjs', 'module'],
        ['node:buffer', 'synthetic'],
        ['node:process', 'synthetic']
      ])
      expect(runtime.globals.fetch).toBeUndefined()
      expect(runtime.capabilities.network).toMatchObject({ installed: false, status: 'unsupported' })
    } finally {
      await runtime.dispose()
      eventLoop.dispose()
    }
  })

  it('records Git, workspace FS and Relay WebSocket as expected unsupported on base Android', async () => {
    const { eventLoop, runtime } = await createBaseRuntime()
    try {
      expect(CHILD_PROCESS_CAPABILITY_MATRIX.api.gitRemoteConfig.status).toBe('supported')
      expect(runtime.syntheticModules['node:child_process']).toBeUndefined()
      await expect(runtime.moduleLoader!.createPlan('./managed-plugin-git.mjs')).rejects.toMatchObject({
        code: 'ERR_HOLONOMY_MODULE_SYNTHETIC_NOT_FOUND'
      })
      await expect(runtime.moduleLoader!.createPlan('./workspace-fs.mjs')).rejects.toMatchObject({
        code: 'ERR_HOLONOMY_MODULE_SYNTHETIC_NOT_FOUND'
      })
      await expect(runtime.moduleLoader!.createPlan('./relay-websocket.mjs')).rejects.toMatchObject({
        code: 'ERR_HOLONOMY_MODULE_NOT_FOUND'
      })
      expect(runtime.capabilities).toMatchObject({
        'child-process': { installed: false, status: 'unsupported' },
        fs: { installed: false, status: 'unsupported' },
        git: { installed: false, status: 'unsupported' },
        'http-server': { installed: false, status: 'unsupported' },
        network: { installed: false, status: 'unsupported' }
      })
    } finally {
      await runtime.dispose()
      eventLoop.dispose()
    }
  })
})
