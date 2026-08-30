import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packages = [
  ['packages/holouv', '@holonomyjs/holouv'],
  ['packages/runtime', '@holonomyjs/runtime'],
  ['packages/capabilities/device', '@holonomyjs/capability-device'],
  ['packages/capabilities/fs', '@holonomyjs/capability-fs'],
  ['packages/capabilities/network', '@holonomyjs/capability-network'],
  ['packages/capabilities/process', '@holonomyjs/capability-process'],
  ['packages/capabilities/system', '@holonomyjs/capability-system'],
  ['packages/plugins/audit', '@holonomyjs/plugin-audit'],
  ['packages/plugins/permission', '@holonomyjs/plugin-permission']
]

for (const [directory, expectedName] of packages) {
  const manifestPath = resolve(root, directory, 'package.json')
  assert.ok(existsSync(manifestPath), `Workspace package is missing: ${directory}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.name, expectedName, `Unexpected package owner for ${directory}`)
  assert.ok(existsSync(resolve(root, directory, 'src/index.ts')), `Package entry is missing: ${directory}`)
  const versions = Object.values({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies
  })
  assert.ok(
    versions.every(version => typeof version === 'string' && !version.startsWith('workspace:')),
    `Publishable manifest contains a workspace protocol: ${directory}`
  )
}

const compatibilityRoots = resolve(root, 'src')
const aggregateEntries = new Set(['capability-runtime/index.ts', 'index.ts'])
const files = []
const visit = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) visit(path)
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path)
  }
}
visit(compatibilityRoots)

for (const path of files) {
  const localPath = relative(compatibilityRoots, path)
  if (aggregateEntries.has(localPath)) continue
  const source = readFileSync(path, 'utf8').trim()
  assert.match(
    source,
    /^export \* from '@holonomyjs\/(?:runtime|capability-[a-z-]+)\/[a-z0-9./-]+'$/u,
    `Legacy source must remain a single scoped-package compatibility export: src/${localPath}`
  )
}

assert.ok(existsSync(resolve(root, 'backends/v86/supervisor/process.c')))
assert.ok(!existsSync(resolve(root, 'adapters/node/backends/v86')))

process.stdout.write(
  `Workspace layout: ${packages.length} packages, ${files.length - aggregateEntries.size} compatibility exports\n`
)
