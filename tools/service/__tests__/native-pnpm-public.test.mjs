import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

import { createNativeRuntimeAdapter } from '../native-target-adapter.mjs'
import { createHolonomyService } from '../server.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const installedProject = process.env.HOLONOMY_NATIVE_PNPM_PROJECT
const cli = fileURLToPath(new URL('../../holonomy.mjs', import.meta.url))
const token = 'native-pnpm-public-token-at-least-thirty-two-bytes'
const createFixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-native-pnpm-')))
  const project = join(root, 'project')
  const home = join(root, 'home')
  await mkdir(join(project, 'node_modules'), { recursive: true })
  await mkdir(home)
  await writeFile(join(home, 'native-runtime.json'), JSON.stringify({ executablePath: binary, schemaVersion: 1 }), {
    mode: 0o600
  })
  await writeFile(join(home, 'token'), token, { mode: 0o600 })
  await writeFile(join(project, 'holo.config.json'), '{"plugins":[{"id":"owner","use":"./host.mjs"}]}')
  await writeFile(join(project, 'host.mjs'), "export default()=>{const value='HOST_PACKAGE_SECRET';void value}")
  return { root, project, home }
}
const invoke = async (f, url, entry = './index.mjs') => {
  const child = spawn(process.execPath, [
    cli,
    'run',
    entry,
    '--target',
    'native',
    '--config',
    'holo.config.json',
    '--detach',
    '--openapi',
    `${url}/openapi.json`,
    '--openapi-token-file',
    join(f.home, 'token')
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
  assert.fail('Public pnpm launch did not settle')
}

describe('public Native package-link snapshots', () => {
  it.skipIf(binary == null || installedProject == null)(
    'runs the preserved real pnpm install through public CLI',
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
        await service.start()
        const result = await invoke(f, service.baseUrl, './index.cjs')
        assert.equal(result.code, 0, result.stderr)
        const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
        const id = JSON.parse(result.stdout).processId
        const ended = await until(() => client.getProcess(id), value => ['exited', 'failed'].includes(value.state))
        const logs = await until(
          () => client.readLogs(id, { after: 0, limit: 256 }),
          value =>
            value.events.some(event => event.chunk.includes('PNPM_REAL_CANONICAL_OK') || event.stream === 'stderr')
        )
        const text = logs.events.map(event => event.chunk).join('')
        assert.equal(ended.exit.code, 0, text)
        assert(text.includes('PNPM_REAL_CANONICAL_OK'), text)
        await client.removeProcess(id, ended.generation, 'pnpm-real-cleanup')
      } finally {
        await service.close()
        await rm(f.root, { recursive: true, force: true })
      }
    },
    20_000
  )

  it.skipIf(binary == null)('preserves transitive lookup, singleton identity and query identities', async () => {
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
      const linked = join(f.project, 'node_modules/.pnpm/linked@1/node_modules/linked')
      const dep = join(f.project, 'node_modules/.pnpm/dep@1/node_modules/dep')
      await mkdir(linked, { recursive: true })
      await mkdir(dep, { recursive: true })
      await writeFile(join(linked, 'package.json'), '{"main":"./index.cjs"}')
      await writeFile(join(linked, 'index.cjs'), 'module.exports={dep:require("dep"),resolved:require.resolve("dep")}')
      await writeFile(join(linked, 'query.mjs'), 'globalThis.n=(globalThis.n??0)+1;export default globalThis.n')
      await writeFile(
        join(linked, 'entry.mjs'),
        "import assert from 'node:assert/strict';import d from 'dep';assert.equal(d.value,42);" +
          "assert(import.meta.url.includes('/.pnpm/linked@1/node_modules/linked/entry.mjs'));" +
          "assert.equal(process.argv[1],import.meta.url);console.log('PUBLIC_ALIAS_ENTRY_OK')"
      )
      await writeFile(join(dep, 'package.json'), '{"main":"./index.cjs"}')
      await writeFile(join(dep, 'index.cjs'), 'module.exports={value:42}')
      await symlink('.pnpm/linked@1/node_modules/linked', join(f.project, 'node_modules/linked'))
      await symlink('.pnpm/dep@1/node_modules/dep', join(f.project, 'node_modules/dep'))
      await symlink('../../dep@1/node_modules/dep', join(linked, '../dep'))
      await writeFile(
        join(f.project, 'index.mjs'),
        [
          "import assert from 'node:assert/strict';import p from 'linked';import d from 'dep';",
          "import same from './node_modules/.pnpm/linked@1/node_modules/linked/index.cjs';",
          "import a from './node_modules/linked/query.mjs?one';",
          "import b from './node_modules/.pnpm/linked@1/node_modules/linked/query.mjs?two';",
          "import c from './node_modules/linked/query.mjs?one#';",
          'assert.equal(p,same);assert.equal(p.dep,d);assert.equal(p.dep.value,42);assert.equal(a+b+c,6);',
          "assert(p.resolved.includes('/.pnpm/dep@1/node_modules/dep/'));",
          "assert.equal(process.versions.node,undefined);console.log('PUBLIC_NATIVE_PNPM_OK')"
        ].join('\n')
      )
      await service.start()
      const result = await invoke(f, service.baseUrl)
      assert.equal(result.code, 0, result.stderr)
      const client = new HolonomyServiceClient({ baseUrl: service.baseUrl, token })
      const id = JSON.parse(result.stdout).processId
      const ended = await until(() => client.getProcess(id), value => ['exited', 'failed'].includes(value.state))
      const operations = ended.exit?.code === 0 ? [] : await until(
        () => client.call('/v1/operations'),
        rows => rows.every(row => ['failed', 'succeeded', 'cancelled'].includes(row.state))
      )
      assert.equal(
        ended.exit?.code,
        0,
        JSON.stringify({
          ended,
          nativeStartupError,
          operations,
          logs: await client.readLogs(id, { after: 0, limit: 256 })
        })
      )
      const logs = await until(
        () => client.readLogs(id, { after: 0, limit: 256 }),
        value => value.events.some(event => /PUBLIC_NATIVE_PNPM_OK/u.test(event.chunk) || event.stream === 'stderr')
      )
      const text = logs.events.map(event => event.chunk).join('')
      assert.equal(ended.exit.code, 0, text)
      assert(text.includes('PUBLIC_NATIVE_PNPM_OK'), text)
      await client.removeProcess(id, ended.generation, 'pnpm-public-cleanup')
      const aliasEntry = await invoke(f, service.baseUrl, './node_modules/linked/entry.mjs')
      assert.equal(aliasEntry.code, 0, aliasEntry.stderr)
      const secondId = JSON.parse(aliasEntry.stdout).processId
      const second = await until(() => client.getProcess(secondId), value => ['exited', 'failed'].includes(value.state))
      assert.equal(second.exit?.code, 0, JSON.stringify(second))
      const secondLogs = await until(
        () => client.readLogs(secondId, { after: 0, limit: 256 }),
        value => value.events.some(event => event.chunk.includes('PUBLIC_ALIAS_ENTRY_OK') || event.stream === 'stderr')
      )
      assert(secondLogs.events.some(event => event.chunk.includes('PUBLIC_ALIAS_ENTRY_OK')))
      await client.removeProcess(secondId, second.generation, 'pnpm-alias-entry-cleanup')
    } finally {
      await service.close()
      await rm(f.root, { recursive: true, force: true })
    }
  }, 20_000)

  it.skipIf(binary == null)('rejects private targets and escapes before any Service HTTP request', async () => {
    const f = await createFixture()
    let requests = 0
    const server = createServer((_request, response) => {
      requests++
      response.writeHead(500).end()
    })
    try {
      await mkdir(join(f.project, 'private'))
      await writeFile(join(f.project, 'private/host.mjs'), "export default()=>{void 'HOST_PACKAGE_SECRET'}")
      await writeFile(join(f.project, 'holo.config.json'), '{"plugins":[{"id":"owner","use":"./private/host.mjs"}]}')
      await symlink('../private', join(f.project, 'node_modules/private-link'))
      await mkdir(join(f.root, 'outside'))
      await writeFile(join(f.root, 'outside/public.mjs'), "console.log('ESCAPED_WORKSPACE')")
      await symlink('../../outside', join(f.project, 'node_modules/outside-link'))
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const url = `http://127.0.0.1:${server.address().port}`
      await writeFile(join(f.project, 'index.mjs'), "console.log('PUBLIC_SOURCE_CONTROL')")
      const control = await invoke(f, url)
      assert.equal(control.code, 1)
      assert(requests > 0, JSON.stringify(control))
      assert(!control.stderr.includes('The Holonomy module host could not read a requested module'))
      requests = 0
      for (const specifier of ['./node_modules/private-link/host.mjs', './node_modules/outside-link/public.mjs']) {
        await writeFile(join(f.project, 'index.mjs'), `import ${JSON.stringify(specifier)};console.log('MUST_NOT_RUN')`)
        const result = await invoke(f, url)
        assert.equal(result.code, 1, result.stdout)
        assert.match(result.stderr, /The Holonomy module host could not read a requested module/u)
        assert.equal(requests, 0)
        assert(!`${result.stdout}${result.stderr}`.includes('HOST_PACKAGE_SECRET'))
        assert(!result.stdout.includes('MUST_NOT_RUN'))
        assert(!result.stdout.includes('ESCAPED_WORKSPACE'))
      }
    } finally {
      await new Promise(resolve => server.close(resolve))
      await rm(f.root, { recursive: true, force: true })
    }
  }, 20_000)
})
