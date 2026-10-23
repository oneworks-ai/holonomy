/* eslint-disable test/no-import-node-test -- Artifact-format security tests, not Guest API assertions. */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { verifyAarEnvelope } from '../aar.mjs'
import { verifySdkArchive } from '../inventory.mjs'
import { packageAndroidSdk } from '../package.mjs'
import { readAarEntry, readAarZip } from '../zip.mjs'
import { fixture } from './fixture.mjs'
import { storedZip } from './zip-fixture.mjs'

const core = [{ name: 'AndroidManifest.xml' }, { name: 'classes.jar' }]

test('ZIP rejects traversal, alternate separators, duplicate identities, links and diagnostic/VM entries', () => {
  for (
    const name of [
      '../outside',
      '/absolute',
      'C:/drive',
      'a\\b',
      'a//b',
      'a/./b',
      'a/../b',
      'control\nname',
      'assets/e2e/fixture.mjs',
      'assets/v86.wasm',
      'assets/.DS_Store',
      'assets/._hidden'
    ]
  ) assert.throws(() => verifyAarEnvelope(storedZip([...core, { name }])), name)
  for (const mode of [0o120777, 0o010644, 0o020644, 0o106444]) {
    assert.throws(() => verifyAarEnvelope(storedZip([...core, { name: 'assets/link', mode }])))
  }
  for (
    const entries of [
      [...core, { name: 'classes.jar' }],
      [...core, { name: 'CLASSES.JAR' }],
      [...core, { name: 'Assets' }, { name: 'assets/member' }]
    ]
  ) assert.throws(() => verifyAarEnvelope(storedZip(entries)))
})

test('central/local names, sizes, flags, CRC and extra interpretation remain one structure', () => {
  const valid = storedZip(core)
  assert.equal(readAarEntry(readAarZip(valid), 'classes.jar').toString(), 'fixture')
  for (const offset of [30, 6, 18]) {
    const changed = Buffer.from(valid)
    changed[offset] ^= 1
    assert.throws(() => readAarZip(changed))
  }
  const changed = Buffer.from(valid)
  const entries = readAarZip(changed)
  changed[entries.get('classes.jar').data] ^= 1
  assert.throws(() => readAarEntry(entries, 'classes.jar'))
  const extra = Buffer.from(valid)
  // A zero-length alternate-name/ZIP64 extra is malformed/unsupported, never silently ignored.
  extra.writeUInt16LE(4, 28)
  assert.throws(() => readAarZip(extra))
})

test('unsafe inner AAR cannot publish any successful SDK completion marker', async context => {
  for (
    const entry of [
      { name: '../escaped-payload' },
      { name: 'assets/symbolic-link', mode: 0o120777, data: '../../outside' },
      { name: 'assets/e2e/diagnostic-fixture.mjs' }
    ]
  ) {
    const root = await fixture(context)
    await writeFile(
      join(root, 'adapters/android/host-core/build/outputs/aar/host-core-debug.aar'),
      storedZip([...core, entry])
    )
    const output = join(root, 'sdk')
    await assert.rejects(packageAndroidSdk({ root, output, skipBuild: true }))
    await assert.rejects(readFile(join(output, 'verification.json')), { code: 'ENOENT' })
    assert.deepEqual(await readdir(output), [])
  }
})

test('all tar modes, including root directory and inner manifest, are enforced', async context => {
  const root = await fixture(context)
  const output = join(root, 'sdk')
  const packaged = await packageAndroidSdk({ root, output, skipBuild: true })
  const bytes = await readFile(join(output, packaged.archiveFile))
  const manifest = await readFile(join(output, 'manifest.json'))
  for (const target of ['root', 'manifest']) {
    const tar = gunzipSync(bytes)
    for (let offset = 0; offset + 512 <= tar.length; offset += 512) {
      const header = tar.subarray(offset, offset + 512)
      const name = header.subarray(0, 100).toString().split('\0')[0]
      const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0/gu, '').trim(), 8)
      if (target === 'root' || name.endsWith('manifest.json')) {
        header.write(target === 'root' ? '0000000\0' : '0007777\0', 100, 'ascii')
        header.fill(32, 148, 156)
        const sum = header.reduce((a, b) => a + b, 0)
        header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
        break
      }
      offset += Math.ceil(size / 512) * 512
    }
    assert.throws(() => verifySdkArchive(gzipSync(tar), manifest), target)
  }
})
