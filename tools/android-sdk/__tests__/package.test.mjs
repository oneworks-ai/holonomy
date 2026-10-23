/* eslint-disable test/no-import-node-test -- SDK build-tool tests, not Guest API assertions. */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { SDK_PAYLOAD_PATHS } from '../files.mjs'
import { readSdkTar, verifySdkArchive } from '../inventory.mjs'
import { packageAndroidSdk, verifyAndroidSdk } from '../package.mjs'

import { fixture, write } from './fixture.mjs'

test('SDK bundle has exact byte inventory, external dependencies and honest completion marker', async context => {
  const root = await fixture(context)
  const output = join(root, 'sdk')
  const result = await packageAndroidSdk({ root, output, skipBuild: true })
  assert.equal(result.status, 'passed')
  assert.equal(result.files, SDK_PAYLOAD_PATHS.length + 1)
  assert.equal(result.deviceTestExecuted, false)
  assert.equal(result.publishReady, false)
  assert.deepEqual(await verifyAndroidSdk(output), result)
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
  assert.equal(manifest.sourceBuild.executed, false)
  assert.equal(manifest.sourceBuild.testsExecuted, false)
  assert.equal(manifest.dependencies.bundled, false)
  assert.equal(manifest.runtimeAssets.assets, 1)
  assert.equal(Object.keys(manifest.files).some(name => /e2e|local.properties|\.apk|v86\.wasm/u.test(name)), false)
  assert.deepEqual(
    (await readdir(output)).sort(),
    ['SHA256SUMS', result.archiveFile, 'manifest.json', 'verification.json'].sort()
  )
})

test('SDK archives are byte-repeatable for identical AAR/source bytes', async context => {
  const root = await fixture(context)
  const a = await packageAndroidSdk({ root, output: join(root, 'a'), skipBuild: true })
  const b = await packageAndroidSdk({ root, output: join(root, 'b'), skipBuild: true })
  assert.deepEqual(await readFile(join(root, 'a', a.archiveFile)), await readFile(join(root, 'b', b.archiveFile)))
})

test('existing directory, user file or symlink output is never overwritten', async context => {
  const root = await fixture(context)
  const output = join(root, 'existing')
  await mkdir(output)
  await writeFile(join(output, 'user-data'), 'keep')
  await assert.rejects(packageAndroidSdk({ root, output, skipBuild: true }), /already exists/u)
  assert.equal(await readFile(join(output, 'user-data'), 'utf8'), 'keep')
  const link = join(root, 'alias')
  await symlink(output, link)
  await assert.rejects(packageAndroidSdk({ root, output: link, skipBuild: true }), /already exists/u)
  assert.deepEqual(await readdir(output), ['user-data'])
})

test('symlink inputs are rejected without opening a successful output', async context => {
  const root = await fixture(context)
  const input = join(root, 'adapters/android/runtime-host/build/outputs/aar/runtime-host-debug.aar')
  await rm(input)
  await symlink(join(root, 'fixture.aar'), input)
  const output = join(root, 'sdk')
  await assert.rejects(packageAndroidSdk({ root, output, skipBuild: true }), /regular files/u)
  await assert.rejects(readFile(join(output, 'verification.json')), { code: 'ENOENT' })
})

test('diagnostic Runtime AAR or stale asset hash cannot publish a completion marker', async context => {
  const root = await fixture(context)
  const aar = join(root, 'aar-source')
  await write(aar, 'assets/runtime/bootstrap.mjs', 'tampered')
  const target = join(root, 'adapters/android/runtime-host/build/outputs/aar/runtime-host-debug.aar')
  await rm(target)
  const zip = spawnSync('/usr/bin/zip', ['-qr', target, '.'], { cwd: aar, encoding: 'utf8' })
  assert.equal(zip.status, 0)
  const output = join(root, 'sdk')
  await assert.rejects(packageAndroidSdk({ root, output, skipBuild: true }), /digest/u)
  await assert.rejects(readFile(join(output, 'verification.json')), { code: 'ENOENT' })
  assert.deepEqual(await readdir(output), [])
})

test('missing marker, changed archive, changed manifest or checksum list fails verification', async context => {
  const root = await fixture(context)
  const output = join(root, 'sdk')
  const result = await packageAndroidSdk({ root, output, skipBuild: true })
  for (const file of [result.archiveFile, 'manifest.json', 'SHA256SUMS', 'verification.json']) {
    const path = join(output, file)
    const original = await readFile(path)
    await writeFile(path, Buffer.concat([original, Buffer.from('changed')]))
    await assert.rejects(verifyAndroidSdk(output))
    await writeFile(path, original)
  }
  await rm(join(output, 'verification.json'))
  await assert.rejects(verifyAndroidSdk(output), { code: 'ENOENT' })
})

test('bounded USTAR parser rejects links, duplicate headers and changed bytes before extraction', async context => {
  const root = await fixture(context)
  const output = join(root, 'sdk')
  const result = await packageAndroidSdk({ root, output, skipBuild: true })
  const archive = await readFile(join(output, result.archiveFile))
  const manifest = await readFile(join(output, 'manifest.json'))
  const raw = gunzipSync(archive)
  const link = Buffer.from(raw)
  link[156] = 50
  link.fill(32, 148, 156)
  const sum = link.subarray(0, 512).reduce((a, b) => a + b, 0)
  link.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  assert.throws(() => readSdkTar(gzipSync(link)))
  assert.throws(() => readSdkTar(gzipSync(Buffer.concat([raw.subarray(0, 512), raw]))))
  for (let offset = 0; offset < raw.length; offset += 512) {
    const size = Number.parseInt(raw.subarray(offset + 124, offset + 136).toString().replace(/\0/gu, '').trim(), 8)
    if (size > 0) {
      raw[offset + 512] ^= 1
      break
    }
  }
  assert.throws(() => verifySdkArchive(gzipSync(raw), manifest))
  const changed = JSON.parse(manifest.toString())
  changed.files['../outside'] = changed.files.LICENSE
  assert.throws(() => verifySdkArchive(archive, Buffer.from(JSON.stringify(changed))))
})
