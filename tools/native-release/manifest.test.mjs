/* eslint-disable test/no-import-node-test -- Build-tool tests run directly without the Runtime test loader. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createManifest, describeFile, readBuildInputs, sha256, validateEngineInfo } from './manifest.mjs'
import { packageNativeRuntime } from './package.mjs'
import { publishPreparedArtifact } from './publication.mjs'

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
  nodeInstalledRequired: false,
  v86BackendCompiled: false,
  platform: 'macos',
  arch: 'aarch64'
}
const fixture = async context => {
  const root = await mkdtemp(join(tmpdir(), 'holo-artifact-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const asset = join(root, 'adapters/desktop/v8-host/generated')
  await mkdir(asset, { recursive: true })
  for (
    const [path, source] of [
      ['package.json', '{"version":"1.0.0-rc.3"}'],
      ['Cargo.toml', 'v8 = "=152.2.0"'],
      ['Cargo.lock', 'locked dependencies'],
      ['pnpm-lock.yaml', 'locked JS dependencies'],
      ['rust-toolchain.toml', 'channel = "1.94.1"'],
      ['binary', 'not executable test data']
    ]
  ) await writeFile(join(root, path), source)
  for (const name of ['runtime', 'control', 'plugin-validator', 'module-planner']) {
    await writeFile(join(asset, `${name}.js`), name)
    await writeFile(join(asset, `${name}.sha256`), sha256(name))
  }
  return root
}

test('accepts only exact native descriptors with all embedded assets', () => {
  assert.deepEqual(validateEngineInfo(info, expected), info)
  for (
    const patch of [
      { engine: 'node' },
      { nodeInstalledRequired: true },
      { v86BackendCompiled: true },
      { platform: 'linux' },
      { arch: 'x86_64' },
      { rustyV8: '151.0.0' },
      { v8: '../unsafe' },
      { runtimeAssetSha256: 'c'.repeat(64) },
      { hostControlAssetSha256: 'c'.repeat(64) },
      { pluginValidatorAssetSha256: 'd'.repeat(64) },
      { modulePlannerAssetSha256: 'e'.repeat(64) },
      { arbitrary: true }
    ]
  ) assert.throws(() => validateEngineInfo({ ...info, ...patch }, expected))
  for (const key of Object.keys(info)) {
    const missing = { ...info }
    delete missing[key]
    assert.throws(() => validateEngineInfo(missing, expected))
  }
})

test('provenance hashes exact input bytes and never claims production release gates', async context => {
  const root = await fixture(context)
  const build = await readBuildInputs(root)
  assert.equal(build.expected.runtimeAssetSha256, sha256('runtime'))
  assert.equal(build.expected.hostControlAssetSha256, sha256('control'))
  assert.equal(build.expected.pluginValidatorAssetSha256, sha256('plugin-validator'))
  assert.equal(build.expected.modulePlannerAssetSha256, sha256('module-planner'))
  assert.equal(build.inputs['Cargo.lock'].sha256, sha256('locked dependencies'))
  const manifest = createManifest({ ...build, engine: info, files: {} })
  assert.equal(manifest.distribution, 'development')
  assert.ok(Object.values(manifest.releaseGates).every(value => value === false))
  assert.equal(manifest.verification.pathContainsNode, false)
})

test('rejects stale generated digest and non-exact engine pins', async context => {
  const root = await fixture(context)
  await writeFile(join(root, 'Cargo.toml'), 'v8 = "152.2.0"')
  await assert.rejects(readBuildInputs(root), /exact rusty_v8 pin/u)
  await writeFile(join(root, 'Cargo.toml'), 'v8 = "=152.2.0"')
  await writeFile(join(root, 'adapters/desktop/v8-host/generated/runtime.js'), 'changed')
  await assert.rejects(readBuildInputs(root), /digest is invalid/u)
})

test('does not accept directories or symlink inputs', async context => {
  const root = await fixture(context)
  await symlink(join(root, 'binary'), join(root, 'link'))
  await assert.rejects(describeFile(root), /regular files/u)
  await assert.rejects(describeFile(join(root, 'link')), /regular files/u)
})

test('existing output is never overwritten or deleted', async context => {
  const root = await fixture(context)
  const output = join(root, 'existing')
  await mkdir(output)
  await writeFile(join(output, 'user-data'), 'keep')
  await assert.rejects(packageNativeRuntime({ root, output, binary: join(root, 'binary') }))
  assert.equal(await readFile(join(output, 'user-data'), 'utf8'), 'keep')
})

test('invalid executable removes private staging without recursively deleting the public output', async context => {
  const root = await fixture(context)
  const output = join(root, 'new-artifact')
  await assert.rejects(packageNativeRuntime({ root, output, binary: join(root, 'binary') }))
  await assert.rejects(readFile(join(output, 'manifest.json')))
  assert.deepEqual(await readdir(output), [])
  assert.equal(await readFile(join(root, 'binary'), 'utf8'), 'not executable test data')
})

test('failure preserves a file created inside the public output while the command is running', async context => {
  const root = await fixture(context)
  const output = join(root, 'new-artifact')
  // This test-only executable creates the competing user file, then fails engine verification.
  await writeFile(join(root, 'binary'), '#!/bin/sh\nprintf keep > ../user-data\nexit 1\n')
  await assert.rejects(packageNativeRuntime({ root, output, binary: join(root, 'binary') }))
  assert.equal(await readFile(join(output, 'user-data'), 'utf8'), 'keep')
  assert.deepEqual(await readdir(output), ['user-data'])
})

test('incomplete publication has no passed marker and never overwrites an existing file', async context => {
  const root = await fixture(context)
  const prepared = join(root, 'prepared')
  const output = join(root, 'output')
  await mkdir(prepared)
  await mkdir(output)
  const archive = 'holo-test.tar.gz'
  for (const path of [archive, 'manifest.json', 'verification.json', 'SHA256SUMS']) {
    await writeFile(join(prepared, path), path)
  }
  await writeFile(join(output, 'SHA256SUMS'), 'user-owned')
  await assert.rejects(publishPreparedArtifact(prepared, output, archive), { code: 'EEXIST' })
  assert.equal(await readFile(join(output, 'SHA256SUMS'), 'utf8'), 'user-owned')
  await assert.rejects(readFile(join(output, 'verification.json')), { code: 'ENOENT' })
})
