import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import { parse } from 'acorn'
import { generateCapabilityKernelFixture } from './generate-capability-kernel-fixture.mjs'
import { generateProcessBackendProbe } from './generate-process-backend-probe.mjs'
import { verifyGeneratedRuntimeAssets } from './verify-generated-runtime-assets.mjs'

const [compiledRoot, sourceRoot, bootstrapRoot, fixtureRoot, acornPath, outputRoot] = process.argv.slice(2)
if ([compiledRoot, sourceRoot, bootstrapRoot, fixtureRoot, acornPath, outputRoot].some(value => value == null)) {
  throw new Error('prepare-runtime-assets requires six paths')
}

const fixtures = new Set(['managed-plugin.mjs'])
const hostResolvedBootstrapModules = new Set(['holo-plugins:///manifest.mjs'])
const optionalV86ProbeAssets = new Map([
  ['libv86.mjs', 'runtime/process-backends/v86/libv86.mjs'],
  ['v86.wasm', 'runtime/process-backends/v86/v86.wasm'],
  ['seabios.bin', 'runtime/process-backends/v86/seabios.bin'],
  ['kernel.bin', 'runtime/process-backends/v86/kernel.bin'],
  ['supervisor.cpio', 'runtime/process-backends/v86/supervisor.cpio']
])
const assets = new Map()
const typescriptSources = new Map()
const repositoryRoot = dirname(sourceRoot)
const require = createRequire(import.meta.url)
const cordisPath = require.resolve('cordis')
const cosmokitPath = resolve(dirname(createRequire(cordisPath).resolve('cosmokit/package.json')), 'lib/index.mjs')

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const normalizedRelative = (root, target) => relative(root, target).split(sep).join('/')
const assertWithin = (root, target) => {
  const item = normalizedRelative(root, target)
  if (item === '' || item === '..' || item.startsWith('../')) throw new Error('Asset graph escaped its root')
  return item
}

const dependencies = (source, file) => {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const output = []
  const stack = [ast]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node == null || typeof node !== 'object') continue
    if (
      (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
        node.type === 'ExportNamedDeclaration') && typeof node.source?.value === 'string'
    ) output.push(node.source.value)
    if (node.type === 'ImportExpression' && typeof node.source?.value === 'string') output.push(node.source.value)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) stack.push(...value)
      else if (value != null && typeof value === 'object') stack.push(value)
    }
  }
  if (output.some(value => value.includes('\0'))) throw new Error(`Invalid import in ${file}`)
  return output
}

const recordAsset = (sourceFile, assetPath, kind, guestReadable = false) => {
  if (assets.has(assetPath)) return false
  const bytes = readFileSync(sourceFile)
  assets.set(assetPath, {
    guestReadable,
    kind,
    path: assetPath,
    sha256: sha256(bytes),
    source: normalizedRelative(repositoryRoot, sourceFile)
  })
  mkdirSync(dirname(resolve(outputRoot, assetPath)), { recursive: true })
  cpSync(sourceFile, resolve(outputRoot, assetPath))
  return true
}

const recordGeneratedAsset = ({ bytes, path: assetPath, source }, kind) => {
  if (assets.has(assetPath)) throw new Error(`Duplicate generated Runtime asset: ${assetPath}`)
  assets.set(assetPath, {
    guestReadable: false,
    kind,
    path: assetPath,
    sha256: sha256(bytes),
    source
  })
  mkdirSync(dirname(resolve(outputRoot, assetPath)), { recursive: true })
  writeFileSync(resolve(outputRoot, assetPath), bytes)
}

const visitCompiled = (file) => {
  const relativePath = assertWithin(compiledRoot, file)
  if (!relativePath.endsWith('.js')) throw new Error(`Non-JavaScript runtime dependency: ${relativePath}`)
  const assetPath = `runtime/modules/${relativePath}`
  if (!recordAsset(file, assetPath, 'runtime-output')) return
  const sourceFile = resolve(sourceRoot, relativePath.replace(/\.js$/u, '.ts'))
  const sourceBytes = readFileSync(sourceFile)
  typescriptSources.set(`src/${normalizedRelative(sourceRoot, sourceFile)}`, sha256(sourceBytes))
  for (const specifier of dependencies(readFileSync(file, 'utf8'), file)) {
    if (specifier === 'acorn' || specifier === 'cordis') continue
    if (!specifier.startsWith('.')) throw new Error(`Unreviewed bare runtime dependency: ${specifier}`)
    visitCompiled(resolve(dirname(file), specifier))
  }
}

const visitBootstrap = (file) => {
  const relativePath = assertWithin(bootstrapRoot, file)
  if (!recordAsset(file, `runtime/${relativePath}`, 'bootstrap')) return
  for (const specifier of dependencies(readFileSync(file, 'utf8'), file)) {
    if (specifier.startsWith('./modules/')) {
      visitCompiled(resolve(compiledRoot, specifier.slice('./modules/'.length)))
    } else if (specifier.startsWith('.')) {
      visitBootstrap(resolve(dirname(file), specifier))
    } else if (hostResolvedBootstrapModules.has(specifier)) {
      continue
    } else {
      throw new Error(`Unreviewed bootstrap dependency: ${specifier}`)
    }
  }
}

const main = async () => {
  rmSync(outputRoot, { force: true, recursive: true })
  mkdirSync(outputRoot, { recursive: true })
  visitBootstrap(resolve(bootstrapRoot, 'bootstrap.mjs'))
  recordAsset(
    resolve(dirname(bootstrapRoot), 'backendProbe/v86-probe-shim.mjs'),
    'runtime/process-backends/v86/probe-shim.mjs',
    'backend-probe'
  )
  recordAsset(
    resolve(dirname(bootstrapRoot), 'backendProbe/v86-fuse-probe.mjs'),
    'runtime/process-backends/v86/fuse-probe.mjs',
    'backend-probe'
  )
  recordAsset(
    resolve(dirname(bootstrapRoot), 'backendProbe/v86-probe.mjs'),
    'runtime/process-backends/v86/probe.mjs',
    'backend-probe'
  )
  recordAsset(
    resolve(dirname(bootstrapRoot), 'backendProbe/v86-trusted-backend-probe.mjs'),
    'runtime/process-backends/v86/trusted-backend-probe.mjs',
    'backend-probe'
  )
  recordAsset(acornPath, 'runtime/vendor/acorn.mjs', 'vendor')
  recordAsset(cordisPath, 'runtime/vendor/cordis.mjs', 'vendor')
  recordAsset(cosmokitPath, 'runtime/vendor/cosmokit.mjs', 'vendor')
  for (const fixture of fixtures) {
    recordAsset(resolve(fixtureRoot, fixture), `runtime/fixtures/${fixture}`, 'fixture', true)
  }
  recordGeneratedAsset(generateProcessBackendProbe(), 'backend-probe')
  const v86ProbeRoot = process.env.HOLO_V86_PROBE_ASSET_ROOT
  if (v86ProbeRoot != null && v86ProbeRoot !== '') {
    for (const [fileName, assetPath] of optionalV86ProbeAssets) {
      recordGeneratedAsset({
        bytes: readFileSync(resolve(v86ProbeRoot, fileName)),
        path: assetPath,
        source: `external:v86-probe/${fileName}`
      }, 'backend-probe')
    }
  }
  recordGeneratedAsset(await generateCapabilityKernelFixture(), 'contract-fixture')

  const manifest = {
    assets: [...assets.values()].sort((left, right) => left.path.localeCompare(right.path)),
    schemaVersion: 2,
    typescriptSources: [...typescriptSources].sort(([left], [right]) => left.localeCompare(right))
      .map(([path, digest]) => ({ path, sha256: digest }))
  }
  writeFileSync(
    resolve(outputRoot, 'runtime/asset-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  verifyGeneratedRuntimeAssets(manifest, outputRoot)
}

void main()
