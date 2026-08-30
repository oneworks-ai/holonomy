import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import { parse } from 'acorn'
import {
  generateCapabilityFilesystemGenerationFixture,
  generateCapabilityKernelFixture,
  generateCapabilityNetworkContinuationFixture,
  generateCapabilityNetworkPrivateDenyFixture,
  generateCapabilityNetworkRealFixture
} from './generate-capability-kernel-fixture.mjs'
import { generateProcessBackendProbe } from './generate-process-backend-probe.mjs'
import { runtimeWorkspacePackages } from './runtime-workspace-packages.mjs'
import { writeRuntimeAssetManifest } from './write-runtime-asset-manifest.mjs'

const [compiledRoot, sourceRoot, bootstrapRoot, fixtureRoot, acornPath, outputRoot] = process.argv.slice(2)
if ([compiledRoot, sourceRoot, bootstrapRoot, fixtureRoot, acornPath, outputRoot].some(value => value == null)) {
  throw new Error('prepare-runtime-assets requires six paths')
}

const fixtures = new Set(['managed-plugin.mjs'])
const hostResolvedBootstrapModules = new Set(['cordis', 'holo-plugins:///manifest.mjs'])
const trustedRuntimePluginLibraries = Object.freeze([
  '@holonomyjs/plugin-audit',
  '@holonomyjs/plugin-permission'
])
const assets = new Map()
const moduleAliases = new Map()
const typescriptSources = new Map()
const repositoryRoot = dirname(sourceRoot)
const require = createRequire(import.meta.url)
const workspacePackage = name => {
  const packagePath = runtimeWorkspacePackages[name]
  if (packagePath == null) return undefined
  const compiled = dirname(require.resolve(name))
  return Object.freeze({
    compiled,
    prefix: `${packagePath}/`,
    source: resolve(compiled, '..', 'src')
  })
}
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

const recordAsset = (sourceFile, assetPath, kind, guestReadable = false, sourceIdentity) => {
  if (assets.has(assetPath)) return false
  const bytes = readFileSync(sourceFile)
  assets.set(assetPath, {
    guestReadable,
    kind,
    path: assetPath,
    sha256: sha256(bytes),
    source: sourceIdentity ?? normalizedRelative(repositoryRoot, sourceFile)
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

const resolveWorkspaceImport = (specifier) => {
  const match = /^(@holonomyjs\/[a-z-]+)(?:\/(.+))?$/u.exec(specifier)
  if (match == null) return undefined
  const owner = workspacePackage(match[1])
  if (owner == null) return undefined
  const subpath = match[2]
  const entry = subpath == null || subpath === ''
    ? 'index.js'
    : subpath === 'app' || subpath === 'kernel'
    ? `${subpath}/index.js`
    : `${subpath}.js`
  return Object.freeze({
    ...owner,
    file: resolve(owner.compiled, entry)
  })
}

const visitWorkspace = (specifier, workspace, visit) => {
  const target = `runtime/modules/${workspace.prefix}${assertWithin(workspace.compiled, workspace.file)}`
  const previous = moduleAliases.get(specifier)
  if (previous != null && previous !== target) throw new Error(`Conflicting Runtime module alias: ${specifier}`)
  moduleAliases.set(specifier, target)
  visit(workspace.file, workspace)
}

const visitCompiled = (
  file,
  owner = Object.freeze({ compiled: compiledRoot, prefix: '', source: sourceRoot })
) => {
  const relativePath = assertWithin(owner.compiled, file)
  if (!relativePath.endsWith('.js')) throw new Error(`Non-JavaScript runtime dependency: ${relativePath}`)
  const assetPath = `runtime/modules/${owner.prefix}${relativePath}`
  if (!recordAsset(file, assetPath, 'runtime-output', false, `${owner.prefix}dist/${relativePath}`)) return
  const sourceFile = resolve(owner.source, relativePath.replace(/\.js$/u, '.ts'))
  const sourceBytes = readFileSync(sourceFile)
  typescriptSources.set(`${owner.prefix}src/${normalizedRelative(owner.source, sourceFile)}`, sha256(sourceBytes))
  for (const specifier of dependencies(readFileSync(file, 'utf8'), file)) {
    if (specifier === 'acorn' || specifier === 'cordis') continue
    const workspace = resolveWorkspaceImport(specifier)
    if (workspace != null) visitWorkspace(specifier, workspace, visitCompiled)
    else if (specifier.startsWith('.')) visitCompiled(resolve(dirname(file), specifier), owner)
    else throw new Error(`Unreviewed bare runtime dependency: ${specifier}`)
  }
}

const visitBootstrap = (file) => {
  const relativePath = assertWithin(bootstrapRoot, file)
  if (!recordAsset(file, `runtime/${relativePath}`, 'bootstrap')) return
  for (const specifier of dependencies(readFileSync(file, 'utf8'), file)) {
    const workspace = resolveWorkspaceImport(specifier)
    if (specifier.startsWith('./modules/')) {
      visitCompiled(resolve(compiledRoot, specifier.slice('./modules/'.length)))
    } else if (workspace != null) {
      visitWorkspace(specifier, workspace, visitCompiled)
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
  visitBootstrap(resolve(bootstrapRoot, 'plugin-host.mjs'))
  for (const specifier of trustedRuntimePluginLibraries) {
    visitWorkspace(specifier, resolveWorkspaceImport(specifier), visitCompiled)
  }
  recordAsset(
    resolve(dirname(bootstrapRoot), 'backendProbe/v86-probe.mjs'),
    'runtime/process-backends/v86/probe.mjs',
    'backend-probe',
    false,
    'adapters/android/e2e/src/backendProbe/v86-probe.mjs'
  )
  recordAsset(acornPath, 'runtime/vendor/acorn.mjs', 'vendor', false, 'dependency:acorn')
  recordAsset(cordisPath, 'runtime/vendor/cordis.mjs', 'vendor', false, 'dependency:cordis')
  recordAsset(cosmokitPath, 'runtime/vendor/cosmokit.mjs', 'vendor', false, 'dependency:cosmokit')
  for (const fixture of fixtures) {
    recordAsset(resolve(fixtureRoot, fixture), `runtime/fixtures/${fixture}`, 'fixture', true)
  }
  recordGeneratedAsset(generateProcessBackendProbe(), 'backend-probe')
  recordGeneratedAsset(await generateCapabilityKernelFixture(), 'contract-fixture')
  recordGeneratedAsset(await generateCapabilityFilesystemGenerationFixture(), 'contract-fixture')
  recordGeneratedAsset(await generateCapabilityNetworkContinuationFixture(), 'contract-fixture')
  recordGeneratedAsset(await generateCapabilityNetworkPrivateDenyFixture(), 'contract-fixture')
  recordGeneratedAsset(await generateCapabilityNetworkRealFixture(), 'contract-fixture')

  writeRuntimeAssetManifest({ assets, moduleAliases, typescriptSources }, outputRoot)
}

void main()
