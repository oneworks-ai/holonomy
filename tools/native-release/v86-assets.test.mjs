/* eslint-disable test/no-import-node-test -- Build-tool tests run directly without the Runtime test loader. */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { sha256, validateEngineInfo } from './manifest.mjs'
import { readOwnedFile, readPinnedV86Assets } from './v86-assets.mjs'

const fixture = async context => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'holo-v86-package-test-')))
  context.after(() => rm(temp, { recursive: true, force: true }))
  const assets = join(temp, 'assets')
  const source = join(temp, 'source')
  await mkdir(assets)
  await mkdir(join(source, 'adapters/desktop/v8-host/assets'), { recursive: true })
  const contents = {
    'seabios.bin': 'bios',
    'kernel.bin': 'kernel',
    'agent.cpio': 'image',
    'v86.wasm': 'wasm'
  }
  const pins = Object.fromEntries(Object.entries(contents).map(([name, body]) => [name, sha256(body)]))
  for (const [name, body] of Object.entries(contents)) await writeFile(join(assets, name), body)
  await writeFile(join(source, 'adapters/desktop/v8-host/assets/v86.wasm'), contents['v86.wasm'])
  await writeFile(join(source, 'adapters/desktop/v8-host/assets/libv86.js'), 'libv86')
  const spdx = JSON.stringify({
    SPDXID: 'SPDXRef-DOCUMENT',
    spdxVersion: 'SPDX-2.3',
    documentNamespace: `https://holonomy.dev/spdx/v86/agent/${pins['agent.cpio']}`,
    packages: [{
      SPDXID: 'SPDXRef-Package-1',
      name: 'busybox',
      versionInfo: '1.0',
      licenseDeclared: 'GPL-2.0-only'
    }]
  })
  await writeFile(join(assets, 'agent.spdx.json'), spdx)
  await writeFile(
    join(assets, 'agent.manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      architecture: 'linux-x86-32',
      profileId: 'agent',
      artifact: { name: 'agent.cpio', sha256: pins['agent.cpio'], size: 5 },
      packageCount: 1,
      sbom: { name: 'agent.spdx.json', sha256: sha256(spdx), size: Buffer.byteLength(spdx) }
    })
  )
  const pinsFile = join(temp, 'pins.json')
  await writeFile(pinsFile, JSON.stringify({ schemaVersion: 1, assets: pins }), { mode: 0o600 })
  return { assets, source, pinsFile }
}

test('feature binary requires the explicit descriptor branch', () => {
  const expected = {
    rustyV8: '152.2.0',
    runtimeAssetSha256: 'a'.repeat(64),
    hostControlAssetSha256: 'b'.repeat(64),
    pluginValidatorAssetSha256: 'c'.repeat(64),
    modulePlannerAssetSha256: 'd'.repeat(64)
  }
  const info = {
    engine: 'embedded-v8',
    v8: '15.2.124.1-rusty',
    ...expected,
    v86BackendCompiled: true,
    nodeInstalledRequired: false,
    platform: 'macos',
    arch: 'aarch64'
  }
  assert.throws(() => validateEngineInfo(info, expected))
  assert.deepEqual(validateEngineInfo(info, expected, { v86BackendCompiled: true }), info)
})

test('pinned owner-controlled assets bind image, Wasm, and SPDX inventory', async context => {
  const { assets, source, pinsFile } = await fixture(context)
  const result = await readPinnedV86Assets({ root: assets, pinsFile, sourceRoot: source })
  assert.equal(result.manifest.assets['agent.cpio'].sha256, sha256('image'))
  assert.equal(result.manifest.agentSpdxInventory.sha256, sha256(await readFile(join(assets, 'agent.spdx.json'))))
  await writeFile(join(assets, 'kernel.bin'), 'changed')
  await assert.rejects(
    readPinnedV86Assets({ root: assets, pinsFile, sourceRoot: source }),
    /digest mismatch: kernel.bin/u
  )
})

test('matching SPDX bytes alone cannot disguise a different image inventory', async context => {
  const { assets, source, pinsFile } = await fixture(context)
  const spdx = JSON.parse(await readFile(join(assets, 'agent.spdx.json'), 'utf8'))
  spdx.packages[0].licenseDeclared = ''
  const bytes = JSON.stringify(spdx)
  await writeFile(join(assets, 'agent.spdx.json'), bytes)
  const manifestPath = join(assets, 'agent.manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.sbom = { name: 'agent.spdx.json', sha256: sha256(bytes), size: Buffer.byteLength(bytes) }
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(
    readPinnedV86Assets({ root: assets, pinsFile, sourceRoot: source }),
    /SPDX content does not match/u
  )
})

test('nofollow inputs and owner-only pins are enforced', async context => {
  const { assets, source, pinsFile } = await fixture(context)
  const linked = join(assets, 'linked')
  await symlink(join(assets, 'agent.cpio'), linked)
  await assert.rejects(readOwnedFile(linked))
  const aliasedRoot = join(source, 'aliased-assets')
  await symlink(assets, aliasedRoot)
  await assert.rejects(readOwnedFile(join(aliasedRoot, 'agent.cpio')), /symlink aliases/u)
  await chmod(pinsFile, 0o644)
  await assert.rejects(
    readPinnedV86Assets({ root: assets, pinsFile, sourceRoot: source }),
    /owner-controlled regular file/u
  )
  await chmod(pinsFile, 0o600)
  const pins = JSON.parse(await readFile(pinsFile, 'utf8'))
  pins.assets['agent.cpio'] = 'f'.repeat(64)
  await writeFile(pinsFile, JSON.stringify(pins))
  await assert.rejects(
    readPinnedV86Assets({ root: assets, pinsFile, sourceRoot: source }),
    /digest mismatch: agent.cpio/u
  )
})
