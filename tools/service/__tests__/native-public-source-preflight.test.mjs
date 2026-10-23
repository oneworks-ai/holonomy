import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

import { createHolonomyService } from '../server.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const cli = fileURLToPath(new URL('../../holonomy.mjs', import.meta.url))
const token = 'native-source-public-token-at-least-thirty-two-bytes'
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-public-source-')))
  const project = join(root, 'project')
  const home = join(root, 'home')
  await mkdir(project)
  await mkdir(home)
  await writeFile(
    join(home, 'native-runtime.json'),
    JSON.stringify({
      executablePath: binary,
      schemaVersion: 1
    }),
    { mode: 0o600 }
  )
  await writeFile(join(home, 'token'), token, { mode: 0o600 })
  await writeFile(join(project, 'holo.config.json'), '{"plugins":[{"id":"owner","use":"./host.mjs"}]}')
  await writeFile(join(project, 'host.mjs'), "import secret from './host-lib.mjs';export default()=>{void secret}")
  await writeFile(join(project, 'host-lib.mjs'), "export default 'PRIVATE_SOURCE_SENTINEL'")
  return { root, project, home }
}
const invoke = async (f, url, entry, extra = []) => {
  const child = spawn(process.execPath, [
    cli,
    'run',
    entry,
    '--target',
    'native',
    '--config',
    'holo.config.json',
    '--openapi',
    `${url}/openapi.json`,
    '--openapi-token-file',
    join(f.home, 'token'),
    ...extra
  ], { cwd: f.project, env: { ...process.env, HOLONOMY_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', bytes => stdout += bytes)
  child.stderr.on('data', bytes => stderr += bytes)
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
  try {
    const [code] = await once(child, 'close')
    return { code, stderr, stdout }
  } finally {
    clearTimeout(timer)
  }
}
const until = async (read, accepts) => {
  for (let turn = 0; turn < 500; turn++) {
    const value = await read()
    if (accepts(value)) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Public Native source launch did not settle')
}

describe('public CLI native source publication', () => {
  it.skipIf(binary == null)(
    'retains Guest roles when a Native plugin watch candidate promotes public source',
    async () => {
      const f = await fixture()
      const service = createHolonomyService({
        nativeExecutablePath: binary,
        port: 0,
        stateDirectory: join(f.home, 'state'),
        token
      })
      let child
      let completed
      let stdout = ''
      let stderr = ''
      try {
        await writeFile(join(f.project, 'public.mjs'), 'export default()=>{}')
        await writeFile(
          join(f.project, 'watch.mjs'),
          "import './public.mjs';console.log('PUBLIC_WATCH_READY');setInterval(()=>{},1000)"
        )
        await service.start()
        child = spawn(process.execPath, [
          cli,
          'run',
          './watch.mjs',
          '--target',
          'native',
          '--config',
          'holo.config.json',
          '--watch',
          '--openapi',
          `${service.baseUrl}/openapi.json`,
          '--openapi-token-file',
          join(f.home, 'token')
        ], { cwd: f.project, env: { ...process.env, HOLONOMY_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe'] })
        child.stdout.on('data', bytes => stdout += bytes)
        child.stderr.on('data', bytes => stderr += bytes)
        completed = once(child, 'close')
        await until(() => stdout, text => text.includes('PUBLIC_WATCH_READY'))
        const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
        const processes = await client.call('/v1/processes')
        assert.equal(processes.length, 1)
        const initial = processes[0]
        await writeFile(join(f.project, 'holo.config.json'), '{"plugins":[{"id":"promoted","use":"./public.mjs"}]}')
        await until(() => stderr, text => text.includes('candidate was rejected'))
        const retained = await client.getProcess(initial.id)
        assert.equal(retained.pluginGraphRevision, initial.pluginGraphRevision)
        assert.equal(retained.state, 'running')
        child.kill('SIGINT')
        const [code] = await completed
        assert.equal(code, 130, stderr)
      } finally {
        if (child != null && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
          await completed
        }
        await service.close()
        await rm(f.root, { recursive: true, force: true })
      }
    },
    20_000
  )

  it.skipIf(binary == null)('runs a physical package graph through real CLI, Service and Native', async () => {
    const f = await fixture()
    const service = createHolonomyService({
      nativeExecutablePath: binary,
      port: 0,
      stateDirectory: join(f.home, 'state'),
      token
    })
    try {
      await mkdir(join(f.project, 'lib'))
      await mkdir(join(f.project, 'node_modules', 'physical-pkg'), { recursive: true })
      await writeFile(join(f.project, 'package.json'), '{"type":"module","imports":{"#value":"./lib/value.mjs"}}')
      await writeFile(join(f.project, 'lib', 'value.mjs'), 'export default 40')
      await writeFile(join(f.project, 'node_modules', 'physical-pkg', 'package.json'), '{"exports":"./index.mjs"}')
      await writeFile(join(f.project, 'node_modules', 'physical-pkg', 'index.mjs'), 'export default 2')
      await writeFile(join(f.project, 'query.mjs'), 'globalThis.n=(globalThis.n??0)+1;export default globalThis.n')
      await writeFile(
        join(f.project, 'index.js'),
        [
          "import assert from 'node:assert/strict';import a from '#value';import b from 'physical-pkg';",
          "import x from './query.mjs?one';import y from './query.mjs?two';",
          'assert.equal(a+b,42);assert.equal(x+y,3);assert.equal(process.versions.node,undefined);',
          "console.log('PUBLIC_NATIVE_PACKAGE_OK')"
        ].join('\n')
      )
      await service.start()
      const result = await invoke(f, service.baseUrl, './index.js', ['--detach'])
      assert.equal(result.code, 0, result.stderr)
      const id = JSON.parse(result.stdout).processId
      const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
      const ended = await until(() => client.getProcess(id), value => ['exited', 'failed'].includes(value.state))
      const logs = await until(
        () => client.readLogs(id, { after: 0, limit: 256 }),
        page =>
          page.events.some(event => event.chunk.includes('PUBLIC_NATIVE_PACKAGE_OK')) ||
          page.events.some(event => event.stream === 'stderr')
      )
      const text = logs.events.map(event => event.chunk).join('')
      assert.equal(ended.exit.code, 0, text)
      assert(text.includes('PUBLIC_NATIVE_PACKAGE_OK'), text)
      await client.removeProcess(id, ended.generation, 'public-source-remove')
    } finally {
      await service.close()
      await rm(f.root, { recursive: true, force: true })
    }
  }, 20_000)

  it.skipIf(binary == null)('rejects original Host sources and aliases before contacting Service', async () => {
    const f = await fixture()
    let requests = 0
    const server = createServer((_request, response) => {
      requests++
      response.writeHead(500).end()
    })
    try {
      await link(join(f.project, 'host.mjs'), join(f.project, 'host-alias.mjs'))
      await link(join(f.project, 'holo.config.json'), join(f.project, 'config-alias.json'))
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const url = `http://127.0.0.1:${server.address().port}`
      const cases = [
        ['same.mjs', "import './host.mjs';console.log('MUST_NOT_RUN')"],
        ['alias.mjs', "import './host-alias.mjs';console.log('MUST_NOT_RUN')"],
        ['dependency.mjs', "import './host-lib.mjs';console.log('MUST_NOT_RUN')"],
        ['config.cjs', "require('./config-alias.json');console.log('MUST_NOT_RUN')"]
      ]
      for (const [entry, source] of cases) {
        await writeFile(join(f.project, entry), source)
        const result = await invoke(f, url, `./${entry}`)
        assert.equal(result.code, 1, result.stderr)
        assert(!result.stdout.includes('MUST_NOT_RUN'), result.stdout)
        assert(!result.stderr.includes('PRIVATE_SOURCE_SENTINEL'), result.stderr)
      }
      assert.equal(requests, 0, 'Rejected source publication contacted Service')
    } finally {
      await new Promise(resolve => server.close(resolve))
      await rm(f.root, { recursive: true, force: true })
    }
  }, 20_000)
})
