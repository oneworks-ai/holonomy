import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import { parse } from 'acorn'

const [compiledRoot, sourceRoot, bootstrapRoot, fixtureRoot, acornPath, outputRoot] = process.argv.slice(2)
if ([compiledRoot, sourceRoot, bootstrapRoot, fixtureRoot, acornPath, outputRoot].some(value => value == null)) {
  throw new Error('prepare-runtime-assets requires six paths')
}

const fixtures = new Set(['managed-plugin.mjs'])
const assets = new Map()
const typescriptSources = new Map()
const repositoryRoot = dirname(sourceRoot)

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

const visitCompiled = (file) => {
  const relativePath = assertWithin(compiledRoot, file)
  if (!relativePath.endsWith('.js')) throw new Error(`Non-JavaScript runtime dependency: ${relativePath}`)
  const assetPath = `runtime/modules/${relativePath}`
  if (!recordAsset(file, assetPath, 'runtime-output')) return
  const sourceFile = resolve(sourceRoot, relativePath.replace(/\.js$/u, '.ts'))
  const sourceBytes = readFileSync(sourceFile)
  typescriptSources.set(`src/${normalizedRelative(sourceRoot, sourceFile)}`, sha256(sourceBytes))
  for (const specifier of dependencies(readFileSync(file, 'utf8'), file)) {
    if (specifier === 'acorn') continue
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
    } else {
      throw new Error(`Unreviewed bootstrap dependency: ${specifier}`)
    }
  }
}

const listFiles = root =>
  readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const target = resolve(root, entry.name)
    return entry.isDirectory() ? listFiles(target) : [target]
  })

const verifyOutput = manifest => {
  const expected = new Set([...manifest.assets.map(asset => asset.path), 'runtime/asset-manifest.json'])
  const actual = new Set(listFiles(outputRoot).map(file => normalizedRelative(outputRoot, file)))
  if (expected.size !== actual.size || [...expected].some(file => !actual.has(file))) {
    throw new Error('Generated runtime assets contain a stale, missing, or extra file')
  }
  for (const asset of manifest.assets) {
    if (sha256(readFileSync(resolve(outputRoot, asset.path))) !== asset.sha256) {
      throw new Error(`Generated runtime asset digest mismatch: ${asset.path}`)
    }
  }
}

rmSync(outputRoot, { force: true, recursive: true })
mkdirSync(outputRoot, { recursive: true })
visitBootstrap(resolve(bootstrapRoot, 'bootstrap.mjs'))
recordAsset(acornPath, 'runtime/vendor/acorn.mjs', 'vendor')
for (const fixture of fixtures) {
  recordAsset(resolve(fixtureRoot, fixture), `runtime/fixtures/${fixture}`, 'fixture', true)
}

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
verifyOutput(manifest)

const stalePath = resolve(outputRoot, 'runtime/stale-regression.tmp')
writeFileSync(stalePath, 'stale')
let rejectedExtra = false
try {
  verifyOutput(manifest)
} catch {
  rejectedExtra = true
}
rmSync(stalePath)
if (!rejectedExtra) throw new Error('Extra asset regression was not rejected')

const digestTarget = resolve(outputRoot, manifest.assets[0].path)
const original = readFileSync(digestTarget)
writeFileSync(digestTarget, Buffer.concat([original, Buffer.from('stale')]))
let rejectedStale = false
try {
  verifyOutput(manifest)
} catch {
  rejectedStale = true
}
writeFileSync(digestTarget, original)
if (!rejectedStale) throw new Error('Stale asset regression was not rejected')
verifyOutput(manifest)

if (statSync(resolve(outputRoot, 'runtime/asset-manifest.json')).size === 0) {
  throw new Error('Generated runtime asset manifest is empty')
}
