/* eslint-disable test/no-import-node-test -- Build-tool tests run directly without the Runtime test loader. */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { describeFile } from './manifest.mjs'
import { verifyResolvedNoticeIndex, writeResolvedNoticeIndex } from './resolved-notice-bundle.mjs'
import { parseCargoTree, readPackageLeaf } from './resolved-notice-index.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const assetNames = ['runtime', 'control', 'plugin-validator', 'module-planner']
const hashes = assetNames.map(sha256)

test('Cargo tree separates workspace identity and duplicate resolved nodes', () => {
  const rows = parseCargoTree('ring v0.17.14\nring v0.17.14 (*)\nholonomy-cli v1.0.0 (/source/tools/native-cli)\n')
  assert.deepEqual(rows, [
    { name: 'holonomy-cli', version: '1.0.0', workspace: true },
    { name: 'ring', version: '0.17.14', workspace: false }
  ])
  assert.throws(() => parseCargoTree('not a package'), /Invalid Cargo tree package/u)
})

test('installed npm notice reader rejects symlink, directory and oversized text', async context => {
  const temporary = await mkdtemp(join(tmpdir(), 'holo-notice-leaf-test-'))
  context.after(() => rm(temporary, { recursive: true, force: true }))
  const root = await realpath(temporary)
  const packageRoot = 'node_modules/.pnpm/acorn@8.18.0/node_modules/acorn'
  await mkdir(join(root, packageRoot), { recursive: true })
  await writeFile(join(root, packageRoot, 'LICENSE'), 'known text')
  assert.equal((await readPackageLeaf(root, packageRoot, 'LICENSE', 32)).toString(), 'known text')
  assert.equal((await readPackageLeaf(`${root}/`, packageRoot, 'LICENSE', 32)).toString(), 'known text')
  await symlink(join(root, packageRoot, 'LICENSE'), join(root, packageRoot, 'NOTICE'))
  await assert.rejects(readPackageLeaf(root, packageRoot, 'NOTICE', 32))
  await mkdir(join(root, packageRoot, 'COPYING'))
  await assert.rejects(readPackageLeaf(root, packageRoot, 'COPYING', 32))
  await assert.rejects(readPackageLeaf(root, packageRoot, 'LICENSE', 4), /Invalid installed npm package text/u)
})

test('resolved index binds exact candidate text bytes and locked component identities', async context => {
  const bundle = await mkdtemp(join(tmpdir(), 'holo-notice-index-test-'))
  context.after(() => rm(bundle, { recursive: true, force: true }))
  await mkdir(join(bundle, 'provenance'))
  const crateText = Buffer.from('ring license text\n')
  const npmText = Buffer.from('acorn license text\n')
  const cratePath = 'licenses/resolved/cargo/ring%400.17.14/LICENSE'
  const npmPath = 'licenses/resolved/pnpm/acorn%408.18.0/LICENSE'
  const npmInput = 'node_modules/.pnpm/acorn@8.18.0/node_modules/acorn/dist/acorn.mjs'
  const cargoLock = [{ name: 'ring', version: '0.17.14', source: 'registry+test', checksum: 'a'.repeat(64) }]
  const pnpmLock = [{
    name: 'acorn',
    version: '8.18.0',
    tarball: 'https://registry.npmjs.org/acorn.tgz',
    checksum: { algorithm: 'SHA512', value: 'b'.repeat(128) }
  }]
  const index = {
    schemaVersion: 1,
    cargoFeature: 'default',
    assets: assetNames.map((name, i) => ({
      name,
      sha256: hashes[i],
      inputs: [{ path: i === 0 ? npmInput : `source/${name}.mjs`, sha256: 'c'.repeat(64) }]
    })),
    cargo: [{
      name: 'ring',
      version: '0.17.14',
      reachability: 'normal',
      source: 'registry+test',
      checksum: 'a'.repeat(64),
      archiveSha256: 'a'.repeat(64),
      notices: [{
        sourcePath: 'ring-0.17.14/LICENSE',
        path: cratePath,
        bytes: crateText.length,
        sha256: sha256(crateText)
      }]
    }],
    pnpm: [{
      name: 'acorn',
      version: '8.18.0',
      tarball: pnpmLock[0].tarball,
      lockIntegrity: pnpmLock[0].checksum,
      sourceAssurance: 'installed-files; npm tarball integrity not independently verified',
      bundles: ['runtime'],
      inputs: [{ path: npmInput, sha256: 'c'.repeat(64), bundles: ['runtime'] }],
      notices: [{
        sourcePath: 'node_modules/acorn/LICENSE',
        path: npmPath,
        bytes: npmText.length,
        sha256: sha256(npmText)
      }]
    }],
    unresolved: []
  }
  const paths = await writeResolvedNoticeIndex({
    bundle,
    evidence: { index, files: new Map([[npmPath, npmText], [cratePath, crateText]]) }
  })
  assert.deepEqual(paths, ['provenance/resolved-notice-index.json', cratePath, npmPath])
  assert.equal(await readFile(join(bundle, npmPath), 'utf8'), 'acorn license text\n')
  const files = {}
  for (const path of paths) files[path] = await describeFile(join(bundle, path))
  const manifest = {
    engine: {
      runtimeAssetSha256: hashes[0],
      hostControlAssetSha256: hashes[1],
      pluginValidatorAssetSha256: hashes[2],
      modulePlannerAssetSha256: hashes[3],
      v86BackendCompiled: false
    },
    files,
    provenance: { resolvedNoticeFiles: paths }
  }
  assert.deepEqual(verifyResolvedNoticeIndex({ index, manifest, cargo: cargoLock, pnpm: pnpmLock }), {
    cargoResolvedPackages: 1,
    npmEmbeddedPackages: 1
  })
  const v86 = structuredClone(index)
  v86.cargoFeature = 'holonomy-desktop-v8/v86-backend'
  v86.assets.push({
    name: 'v86-web-standards',
    sha256: sha256('v86-web-standards'),
    inputs: [{ path: 'source/v86-web-standards.mjs', sha256: 'c'.repeat(64) }]
  })
  const v86Manifest = { ...manifest, engine: { ...manifest.engine, v86BackendCompiled: true } }
  assert.deepEqual(verifyResolvedNoticeIndex({ index: v86, manifest: v86Manifest, cargo: cargoLock, pnpm: pnpmLock }), {
    cargoResolvedPackages: 1,
    npmEmbeddedPackages: 1
  })
  const changed = structuredClone(index)
  changed.pnpm[0].notices[0].sha256 = 'f'.repeat(64)
  assert.throws(
    () => verifyResolvedNoticeIndex({ index: changed, manifest, cargo: cargoLock, pnpm: pnpmLock }),
    /notice text differs/u
  )
  const wrongInput = structuredClone(index)
  wrongInput.pnpm[0].inputs[0].sha256 = 'f'.repeat(64)
  assert.throws(
    () => verifyResolvedNoticeIndex({ index: wrongInput, manifest, cargo: cargoLock, pnpm: pnpmLock }),
    /npm input graph differs/u
  )
  const wrongBundle = structuredClone(index)
  wrongBundle.pnpm[0].inputs[0].bundles = ['control']
  assert.throws(
    () => verifyResolvedNoticeIndex({ index: wrongBundle, manifest, cargo: cargoLock, pnpm: pnpmLock }),
    /npm input graph differs/u
  )
  const omitted = structuredClone(manifest)
  omitted.provenance.resolvedNoticeFiles.pop()
  assert.throws(
    () => verifyResolvedNoticeIndex({ index, manifest: omitted, cargo: cargoLock, pnpm: pnpmLock }),
    /file inventory differs/u
  )
  const wrongLock = [{ ...cargoLock[0], checksum: 'e'.repeat(64) }]
  assert.throws(
    () => verifyResolvedNoticeIndex({ index, manifest, cargo: wrongLock, pnpm: pnpmLock }),
    /Cargo notice identity/u
  )
})
