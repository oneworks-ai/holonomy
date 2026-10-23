/* eslint-disable test/no-import-node-test -- Build-tool tests run directly without the Runtime test loader. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { NATIVE_BUNDLE_DOCUMENTS } from './documents.mjs'
import { createManifest, describeFile, sha256 } from './manifest.mjs'
import {
  parseCargoInventory,
  parsePnpmInventory,
  prepareNativeProvenance,
  verifyNativeProvenance
} from './provenance.mjs'

const integrity = value => createHash('sha512').update(value).digest('base64')

const cargo = `version = 4

[[package]]
name = "v8"
version = "152.2.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${'a'.repeat(64)}"

[[package]]
name = "holonomy-cli"
version = "1.0.0-rc.3"
`
const pnpm = `lockfileVersion: '9.0'

packages:

  acorn@8.18.0:
    resolution: {integrity: sha512-${integrity('acorn')}, tarball: https://registry.npmjs.org/acorn/-/acorn-8.18.0.tgz}

  v86@0.5.432:
    resolution: {integrity: sha512-${integrity('v86')}, tarball: https://registry.npmjs.org/v86/-/v86-0.5.432.tgz}

snapshots:
`
const engine = {
  v8: '15.2.124.1-rusty',
  runtimeAssetSha256: '1'.repeat(64),
  hostControlAssetSha256: '2'.repeat(64),
  pluginValidatorAssetSha256: '3'.repeat(64),
  modulePlannerAssetSha256: '4'.repeat(64)
}

const fixture = async context => {
  const root = await mkdtemp(join(tmpdir(), 'holo-provenance-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const bundle = join(root, 'bundle')
  await mkdir(join(bundle, 'bin'), { recursive: true })
  await mkdir(join(root, 'target/release/gn_out/obj'), { recursive: true })
  await writeFile(join(root, 'Cargo.lock'), cargo)
  await writeFile(join(root, 'pnpm-lock.yaml'), pnpm)
  await writeFile(join(root, 'rust-toolchain.toml'), '[toolchain]\nchannel = "stable"\n')
  await writeFile(join(root, 'target/release/gn_out/obj/librusty_v8.a'), 'linker input')
  await writeFile(join(bundle, 'bin/holo'), 'binary')
  const build = {
    version: '1.0.0-rc.3',
    expected: { rustyV8: '152.2.0' },
    inputs: {
      'Cargo.lock': await describeFile(join(root, 'Cargo.lock')),
      'pnpm-lock.yaml': await describeFile(join(root, 'pnpm-lock.yaml')),
      'rust-toolchain.toml': await describeFile(join(root, 'rust-toolchain.toml'))
    }
  }
  return { root, bundle, build }
}

test('lock inventory keeps exact registry checksums and refuses duplicate identities', () => {
  assert.equal(parseCargoInventory(cargo)[0].checksum, 'a'.repeat(64))
  assert.equal(parsePnpmInventory(pnpm)[1].name, 'v86')
  assert.throws(
    () =>
      parseCargoInventory(
        `${cargo}\n[[package]]\nname = "v8"\nversion = "152.2.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${
          'a'.repeat(64)
        }"\n`
      ),
    /Duplicate/u
  )
  assert.throws(
    () => parsePnpmInventory(pnpm.replace('snapshots:', `  v86@0.5.432:\n    resolution: {}\n\nsnapshots:`)),
    /Invalid pnpm package identity/u
  )
})

test('notices and SPDX bind reviewed engine licenses, locks, binary and embedded JS digests', async context => {
  const { root, bundle, build } = await fixture(context)
  const binary = await describeFile(join(bundle, 'bin/holo'))
  const evidence = await prepareNativeProvenance({ root, bundle, build, engine, binary, v86: null })
  const files = { 'bin/holo': binary }
  for (const name of evidence.files) files[name] = await describeFile(join(bundle, name))
  for (const name of ['DEVELOPMENT.md', ...Object.keys(NATIVE_BUNDLE_DOCUMENTS)]) {
    await writeFile(join(bundle, name), 'development document')
    files[name] = await describeFile(join(bundle, name))
  }
  const manifest = createManifest({ ...build, engine, files, provenance: evidence.summary })
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify(manifest))
  assert.deepEqual(evidence.summary.licenseFiles, ['licenses/rusty-v8-LICENSE', 'licenses/V8-LICENSE'])
  assert.deepEqual(await verifyNativeProvenance({ bundle, manifest }), {
    cargoLockedPackages: 2,
    pnpmLockedPackages: 2
  })
  const notices = JSON.parse(await readFile(join(bundle, 'THIRD-PARTY-NOTICES.json'), 'utf8'))
  const spdx = JSON.parse(await readFile(join(bundle, 'sbom.spdx.json'), 'utf8'))
  assert.equal(notices.components[0].observedLinkArchive.sha256, sha256('linker input'))
  assert.equal(notices.components[1].licenseFile, 'licenses/V8-LICENSE')
  assert.equal(spdx.packages.length, 4)
  assert.equal(manifest.releaseGates.publishReady, false)
  assert.equal(manifest.releaseGates.sbomComplete, false)
  await assert.rejects(
    verifyNativeProvenance({ bundle, manifest: { ...manifest, distribution: 'release' } }),
    /development manifest/u
  )
  await assert.rejects(
    verifyNativeProvenance({ bundle, manifest: { ...manifest, releaseGates: {} } }),
    /development manifest/u
  )
  const missingReadme = structuredClone(manifest)
  delete missingReadme.files['README.md']
  await assert.rejects(verifyNativeProvenance({ bundle, manifest: missingReadme }), /file inventory/u)

  // Rehash a forged notice so the file inventory still matches: semantic
  // verification must reject the mismatch with the binary descriptor.
  notices.embeddedRuntimeAssets.runtime = 'f'.repeat(64)
  await writeFile(join(bundle, 'THIRD-PARTY-NOTICES.json'), `${JSON.stringify(notices)}\n`)
  manifest.files['THIRD-PARTY-NOTICES.json'] = await describeFile(join(bundle, 'THIRD-PARTY-NOTICES.json'))
  await assert.rejects(verifyNativeProvenance({ bundle, manifest }), /embedded asset provenance/u)

  notices.embeddedRuntimeAssets.runtime = engine.runtimeAssetSha256
  await writeFile(join(bundle, 'THIRD-PARTY-NOTICES.json'), `${JSON.stringify(notices)}\n`)
  manifest.files['THIRD-PARTY-NOTICES.json'] = await describeFile(join(bundle, 'THIRD-PARTY-NOTICES.json'))
  spdx.packages[0].versionInfo = 'forged'
  await writeFile(join(bundle, 'sbom.spdx.json'), `${JSON.stringify(spdx)}\n`)
  manifest.files['sbom.spdx.json'] = await describeFile(join(bundle, 'sbom.spdx.json'))
  await assert.rejects(verifyNativeProvenance({ bundle, manifest }), /SPDX Cargo inventory/u)
})

test('v86 source copies must match the pinned npm install and its license', async context => {
  const { root, bundle, build } = await fixture(context)
  const npmRoot = join(root, 'node_modules/v86')
  const sourceRoot = join(root, 'adapters/desktop/v8-host/assets')
  await mkdir(join(npmRoot, 'build'), { recursive: true })
  await mkdir(sourceRoot, { recursive: true })
  await mkdir(join(root, 'backends/v86/images'), { recursive: true })
  await writeFile(
    join(npmRoot, 'package.json'),
    JSON.stringify({
      name: 'v86',
      version: '0.5.432+gf3d4472',
      license: 'BSD-2-Clause'
    })
  )
  for (
    const [name, installed, bytes] of [
      ['libv86.js', 'build/libv86.js', 'source'],
      ['v86.wasm', 'build/v86.wasm', 'wasm'],
      ['v86-LICENSE', 'LICENSE', 'license']
    ]
  ) {
    await writeFile(join(sourceRoot, name), bytes)
    await writeFile(join(npmRoot, installed), bytes)
  }
  for (
    const name of [
      'alpine-source-v1.json',
      'alpine-packages-lock-v1.json',
      'alpine-kernel-lock-v1.json',
      'profiles-v1.json'
    ]
  ) await writeFile(join(root, 'backends/v86/images', name), '{}')
  const v86 = {
    manifest: {
      assets: { 'v86.wasm': { bytes: 4, sha256: sha256('wasm') } },
      sourceAssetInputs: {
        'adapters/desktop/v8-host/assets/libv86.js': { sha256: sha256('source') },
        'adapters/desktop/v8-host/assets/v86.wasm': { sha256: sha256('wasm') }
      },
      agentSpdxInventory: { bytes: 10, sha256: '5'.repeat(64) },
      agentManifest: { bytes: 10, sha256: '6'.repeat(64) }
    }
  }
  const binary = await describeFile(join(bundle, 'bin/holo'))
  const evidence = await prepareNativeProvenance({ root, bundle, build, engine, binary, v86 })
  assert.ok(evidence.files.includes('licenses/v86-LICENSE'))
  const notices = JSON.parse(await readFile(join(bundle, 'THIRD-PARTY-NOTICES.json'), 'utf8'))
  assert.equal(notices.components[2].embeddedAssets['v86.wasm'].sha256, sha256('wasm'))
  await writeFile(join(sourceRoot, 'libv86.js'), 'changed')
  await mkdir(join(root, 'bundle-second'))
  await assert.rejects(
    prepareNativeProvenance({ root, bundle: join(root, 'bundle-second'), build, engine, binary, v86 }),
    /Embedded v86 asset differs/u
  )
})
