import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

import { createNativeRuntimeAdapter } from '../native-target-adapter.mjs'
import { createHolonomyService } from '../server.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const installedProject = process.env.HOLONOMY_NATIVE_HOST_PACKAGE_PROJECT
const cli = fileURLToPath(new URL('../../holonomy.mjs', import.meta.url))
const token = 'native-host-package-token-at-least-thirty-two-bytes'
const policy = {
  codeGeneration: {
    dynamicImport: { access: 'none' },
    strings: { access: 'controlled', decisionTimeoutMs: 1000, maxOperations: 1000, maxSourceBytes: 4096 },
    wasm: { access: 'none' }
  },
  schemaVersion: 2
}
const config = (mode = 'allow') => ({ plugins: [{ id: 'host-package', use: 'host-plugin', config: { mode } }] })
const schema = {
  additionalProperties: false,
  properties: { mode: { enum: ['allow', 'deny'] } },
  required: ['mode'],
  type: 'object'
}
const until = async (read, accepts) => {
  let last
  for (let turn = 0; turn < 800; turn++) {
    last = await read()
    if (accepts(last)) return last
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`Host package operation did not settle: ${JSON.stringify(last)}`)
}
const createFixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-host-package-')))
  const project = join(root, 'project')
  const home = join(root, 'home')
  const packageRoot = join(project, 'node_modules/.pnpm/host-plugin@1/node_modules/host-plugin')
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await mkdir(home)
  await symlink('.pnpm/host-plugin@1/node_modules/host-plugin', join(project, 'node_modules/host-plugin'))
  await writeFile(join(home, 'native-runtime.json'), JSON.stringify({ executablePath: binary, schemaVersion: 1 }), {
    mode: 0o600
  })
  await writeFile(join(home, 'token'), token, { mode: 0o600 })
  await writeFile(join(project, 'holo.config.json'), JSON.stringify(config()))
  await writeFile(
    join(project, 'capability.json'),
    JSON.stringify({
      context: { schemaVersion: 1, host: {}, guest: { application: { id: 'host.package', name: 'Host package' } } },
      initialMiddlewareId: 'service.continue.v1',
      sandboxPolicy: policy,
      schemaVersion: 1
    })
  )
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      holo: { apiVersion: 1, configSchema: './schema.json', entry: './index.mjs', kind: 'runtime-plugin' },
      name: 'host-plugin',
      type: 'module'
    })
  )
  await writeFile(join(packageRoot, 'schema.json'), JSON.stringify(schema))
  await writeFile(
    join(packageRoot, 'index.mjs'),
    "import { decide } from './lib/decision.mjs';export default(c,config)=>{c.holo.engineGate(()=>decide(config));}"
  )
  await writeFile(
    join(packageRoot, 'lib/decision.mjs'),
    "export const secret='HOST_PACKAGE_PRIVATE_SENTINEL';export const decide=c=>c.mode==='allow'?{action:'allow'}:{action:'deny',reasonCode:'host.package_denied'};"
  )
  return { root, project, home, packageRoot }
}
const command = (f, url, entry = './index.mjs', extra = []) => {
  const child = spawn(process.execPath, [
    cli,
    'run',
    entry,
    '--target',
    'native',
    '--config',
    'holo.config.json',
    '--capability-runtime',
    'capability.json',
    '--openapi',
    `${url}/openapi.json`,
    '--openapi-token-file',
    join(f.home, 'token'),
    ...extra
  ], { cwd: f.project, env: { ...process.env, HOLONOMY_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', bytes => output.stdout += bytes)
  child.stderr.on('data', bytes => output.stderr += bytes)
  return { child, output, completed: once(child, 'close') }
}
const invoke = async (f, url, entry = './index.mjs') => {
  const running = command(f, url, entry, ['--detach'])
  const timer = setTimeout(() => running.child.kill('SIGKILL'), 15_000)
  try {
    const [code] = await running.completed
    return { code, ...running.output }
  } finally {
    clearTimeout(timer)
  }
}

describe('public Native pinned Host package sources', () => {
  it.skipIf(binary == null)(
    'preserves pure ESM .js package entry and dependency semantics through staging',
    async () => {
      const f = await createFixture()
      let nativeStartupError = ''
      const service = createHolonomyService({
        nativeAdapter: createNativeRuntimeAdapter({
          executablePath: binary,
          stateDirectory: join(f.home, 'state'),
          spawn(executable, args, options) {
            const child = spawn(executable, args, options)
            child.stderr.on('data', bytes => nativeStartupError = (nativeStartupError + bytes).slice(0, 32_768))
            return child
          }
        }),
        port: 0,
        stateDirectory: join(f.home, 'state'),
        token
      })
      try {
        await rename(join(f.packageRoot, 'index.mjs'), join(f.packageRoot, 'index.js'))
        await rename(join(f.packageRoot, 'lib/decision.mjs'), join(f.packageRoot, 'lib/decision.js'))
        const source = await readFile(join(f.packageRoot, 'index.js'), 'utf8')
        await writeFile(join(f.packageRoot, 'index.js'), source.replace('./lib/decision.mjs', './lib/decision.js'))
        const manifest = JSON.parse(await readFile(join(f.packageRoot, 'package.json'), 'utf8'))
        manifest.holo.entry = './index.js'
        await writeFile(join(f.packageRoot, 'package.json'), JSON.stringify(manifest))
        await writeFile(
          join(f.project, 'index.mjs'),
          "import assert from 'node:assert/strict';assert.equal(eval('6*7'),42);console.log('HOST_PACKAGE_ESM_JS_OK')"
        )
        await service.start()
        const result = await invoke(f, service.baseUrl)
        assert.equal(result.code, 0, result.stderr)
        const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
        const id = JSON.parse(result.stdout).processId
        const ended = await until(() => client.getProcess(id), value => ['exited', 'failed'].includes(value.state))
        assert.equal(ended.exit?.code, 0, JSON.stringify({ ended, nativeStartupError }))
        const logs = await until(
          () => client.readLogs(id, { after: 0, limit: 256 }),
          value => value.events.some(event => event.chunk.includes('HOST_PACKAGE_ESM_JS_OK'))
        )
        assert(logs.events.some(event => event.chunk.includes('HOST_PACKAGE_ESM_JS_OK')))
        await client.removeProcess(id, ended.generation, 'host-package-esm-js-cleanup')
      } finally {
        await service.close()
        await rm(f.root, { recursive: true, force: true })
      }
    },
    20_000
  )

  it.skipIf(binary == null || installedProject == null)(
    'executes a real pnpm Host package without Node and through public CLI',
    async () => {
      const f = await createFixture()
      const service = createHolonomyService({
        nativeExecutablePath: binary,
        port: 0,
        stateDirectory: join(f.home, 'state'),
        token
      })
      try {
        await cp(installedProject, f.project, { recursive: true, verbatimSymlinks: true })
        const standalone = spawn(binary, ['--timeout', '5000', '--host-config', 'host.json', './index.mjs'], {
          cwd: f.project,
          env: { PATH: '' },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let directOutput = ''
        let directError = ''
        standalone.stdout.on('data', bytes => directOutput += bytes)
        standalone.stderr.on('data', bytes => directError += bytes)
        const directTimer = setTimeout(() => standalone.kill('SIGKILL'), 10_000)
        let directCode
        try {
          ;[directCode] = await once(standalone, 'close')
        } finally {
          clearTimeout(directTimer)
        }
        assert.equal(directCode, 0, directError)
        assert(directOutput.includes('NATIVE_HOST_PNPM_PACKAGE_OK'))
        await service.start()
        const started = await invoke(f, service.baseUrl)
        assert.equal(started.code, 0, started.stderr)
        const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
        const id = JSON.parse(started.stdout).processId
        const ended = await until(() => client.getProcess(id), value => ['exited', 'failed'].includes(value.state))
        assert.equal(ended.exit?.code, 0, JSON.stringify(ended))
        const logs = await until(
          () => client.readLogs(id, { after: 0, limit: 256 }),
          value => value.events.some(event => event.chunk.includes('NATIVE_HOST_PNPM_PACKAGE_OK'))
        )
        assert(logs.events.some(event => event.chunk.includes('NATIVE_HOST_PNPM_PACKAGE_OK')))
        await client.removeProcess(id, ended.generation, 'host-package-real-cleanup')
      } finally {
        await service.close()
        await rm(f.root, { recursive: true, force: true })
      }
    },
    25_000
  )

  it.skipIf(binary == null)(
    'applies package config watch and retains last good after Schema or role rejection',
    async () => {
      const f = await createFixture()
      const service = createHolonomyService({
        nativeExecutablePath: binary,
        port: 0,
        stateDirectory: join(f.home, 'state'),
        token
      })
      let running
      try {
        await writeFile(join(f.project, 'public.mjs'), 'export default()=>{}')
        await writeFile(
          join(f.project, 'index.mjs'),
          [
            "import './public.mjs';console.log('HOST_WATCH_ENTRY');",
            "setInterval(()=>{let next;try{if(eval('6*7')!==42)throw Error('wrong result');next='allow'}catch{next='deny'}",
            "console.log('HOST_WATCH_'+next.toUpperCase())},30)"
          ].join('\n')
        )
        await service.start()
        running = command(f, service.baseUrl, './index.mjs', ['--watch'])
        await until(() => running.output, output => output.stdout.includes('HOST_WATCH_ALLOW'))
        const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
        const [initial] = await client.call('/v1/processes')
        const revision = initial.pluginGraphRevision
        await writeFile(join(f.project, 'holo.config.json'), JSON.stringify(config('deny')))
        await until(() => running.output, output => output.stdout.includes('HOST_WATCH_DENY'))
        const denied = await until(
          () => client.getProcess(initial.id),
          value => value.pluginGraphRevision === revision + 1
        )
        assert.equal(denied.state, 'running')
        await writeFile(join(f.project, 'holo.config.json'), JSON.stringify(config('invalid')))
        await until(() => running.output.stderr, text => text.includes('candidate was rejected'))
        assert.equal((await client.getProcess(initial.id)).pluginGraphRevision, revision + 1)
        await writeFile(join(f.project, 'holo.config.json'), JSON.stringify(config('allow')))
        await until(() => client.getProcess(initial.id), value => value.pluginGraphRevision === revision + 2)
        const allowedBeforeAttack = running.output.stdout.match(/HOST_WATCH_ALLOW/gu)?.length ?? 0
        await until(
          () => running.output.stdout,
          text => (text.match(/HOST_WATCH_ALLOW/gu)?.length ?? 0) > allowedBeforeAttack
        )
        const alternate = join(f.project, 'node_modules/.pnpm/host-plugin@2/node_modules/host-plugin')
        await mkdir(alternate, { recursive: true })
        await cp(join(f.packageRoot, 'package.json'), join(alternate, 'package.json'))
        await cp(join(f.packageRoot, 'schema.json'), join(alternate, 'schema.json'))
        await link(join(f.project, 'public.mjs'), join(alternate, 'index.mjs'))
        await unlink(join(f.project, 'node_modules/host-plugin'))
        await symlink('.pnpm/host-plugin@2/node_modules/host-plugin', join(f.project, 'node_modules/host-plugin'))
        const failures = running.output.stderr.match(/candidate was rejected/gu)?.length ?? 0
        await writeFile(join(f.project, 'holo.config.json'), JSON.stringify(config('deny')))
        await until(
          () => running.output.stderr,
          text => (text.match(/candidate was rejected/gu)?.length ?? 0) > failures
        )
        const retained = await client.getProcess(initial.id)
        assert.equal(retained.pluginGraphRevision, revision + 2)
        assert.equal(retained.state, 'running')
        const allowedAfterAttack = running.output.stdout.match(/HOST_WATCH_ALLOW/gu)?.length ?? 0
        await until(
          () => running.output.stdout,
          text => (text.match(/HOST_WATCH_ALLOW/gu)?.length ?? 0) > allowedAfterAttack
        )
        assert.equal(running.output.stdout.match(/HOST_WATCH_ENTRY/gu)?.length, 1)
        running.child.kill('SIGINT')
        const [code] = await running.completed
        assert.equal(code, 130, running.output.stderr)
      } finally {
        if (running != null && running.child.exitCode === null && running.child.signalCode === null) {
          running.child.kill('SIGKILL')
          await running.completed
        }
        await service.close()
        await rm(f.root, { recursive: true, force: true })
      }
    },
    30_000
  )

  it.skipIf(binary == null)(
    'blocks Host package manifest, Schema, modules and hardlinks before Service HTTP',
    async () => {
      const f = await createFixture()
      let requests = 0
      const server = createServer((_request, response) => {
        requests++
        response.writeHead(500).end()
      })
      try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        const url = `http://127.0.0.1:${server.address().port}`
        await writeFile(join(f.project, 'index.mjs'), "console.log('HEALTHY_HOST_PACKAGE')")
        const control = await invoke(f, url)
        assert.equal(control.code, 1)
        assert(requests > 0, JSON.stringify(control))
        requests = 0
        await link(join(f.packageRoot, 'lib/decision.mjs'), join(f.project, 'host-hardlink.mjs'))
        const cases = [
          ['./index.mjs', "import './node_modules/host-plugin/index.mjs'"],
          ['./index.cjs', "require('./node_modules/host-plugin/package.json')"],
          ['./index.cjs', "require('./node_modules/host-plugin/schema.json')"],
          ['./index.mjs', "import './host-hardlink.mjs'"]
        ]
        for (const [entry, source] of cases) {
          await writeFile(join(f.project, entry), `${source};console.log('PRIVATE_PACKAGE_MUST_NOT_RUN')`)
          const rejected = await invoke(f, url, entry)
          assert.equal(rejected.code, 1, rejected.stdout)
          assert.match(rejected.stderr, /The Holonomy module host could not read a requested module/u)
          assert.equal(requests, 0)
          assert(!`${rejected.stdout}${rejected.stderr}`.includes('HOST_PACKAGE_PRIVATE_SENTINEL'))
          assert(!rejected.stdout.includes('PRIVATE_PACKAGE_MUST_NOT_RUN'))
        }
      } finally {
        await new Promise(resolve => server.close(resolve))
        await rm(f.root, { recursive: true, force: true })
      }
    },
    25_000
  )
})
