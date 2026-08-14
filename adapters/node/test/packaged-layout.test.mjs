import assert from 'node:assert/strict'
import { cp, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- This adapter is verified with Node's public test runner.
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const adapterSource = fileURLToPath(new URL('../src', import.meta.url))
const acornPackage = dirname(fileURLToPath(import.meta.resolve('acorn/package.json')))
const ajvPackage = dirname(fileURLToPath(import.meta.resolve('ajv/package.json')))
const cordisPackage = dirname(fileURLToPath(import.meta.resolve('cordis/package.json')))
const cosmokitPackage = dirname(createRequire(import.meta.resolve('cordis')).resolve('cosmokit/package.json'))

test('starts from an installed package layout with runtime dependencies resolved as siblings', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'holonomy-node-package-'))
  t.after(() => rm(temporary, { force: true, recursive: true }))
  const packageRoot = join(temporary, 'node_modules', '@oneworks', 'holonomy')
  await mkdir(join(packageRoot, 'adapters', 'node'), { recursive: true })
  await cp(adapterSource, join(packageRoot, 'adapters', 'node', 'src'), { recursive: true })
  await cp(join(repositoryRoot, 'dist'), join(packageRoot, 'dist'), { recursive: true })
  await cp(join(repositoryRoot, 'src'), join(packageRoot, 'src'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'holonomy', type: 'module' }))
  await mkdir(join(temporary, 'node_modules'), { recursive: true })
  await symlink(acornPackage, join(temporary, 'node_modules', 'acorn'), 'dir')
  await symlink(ajvPackage, join(temporary, 'node_modules', 'ajv'), 'dir')
  await symlink(cordisPackage, join(temporary, 'node_modules', 'cordis'), 'dir')
  await symlink(cosmokitPackage, join(temporary, 'node_modules', 'cosmokit'), 'dir')

  await assert.rejects(() => lstat(join(packageRoot, 'node_modules', 'acorn')), { code: 'ENOENT' })
  await assert.rejects(() => lstat(join(packageRoot, 'node_modules', 'ajv')), { code: 'ENOENT' })
  await assert.rejects(() => lstat(join(packageRoot, 'node_modules', 'cordis')), { code: 'ENOENT' })
  await assert.rejects(() => lstat(join(temporary, 'node_modules', 'typescript')), { code: 'ENOENT' })
  const moduleUrl = pathToFileURL(join(packageRoot, 'adapters', 'node', 'src', 'index.mjs')).href
  const { NodeRuntimeSupervisor } = await import(`${moduleUrl}?installed-layout=${Date.now()}`)
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event))
  await supervisor.start({
    entryUrl: 'app://installed/main.mjs',
    runtimeModules: [],
    syntheticModules: {},
    userModules: [{ source: "console.log('PACKAGED_LAYOUT_OK')", url: 'app://installed/main.mjs' }]
  })
  assert.ok(logs.some(event => event.text === 'PACKAGED_LAYOUT_OK'))
})
