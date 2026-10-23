/* eslint-disable test/no-import-node-test -- Native build-tool contract, not Guest API assertions. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'

import {
  createNativeArchive,
  nativeArchiveMembers,
  verifyNativeArchiveMembers,
  verifyNativeBundleInventory
} from './archive.mjs'

const manifest = { files: { 'bin/holo': {}, 'private/host.json': {} } }
const fixture = async (root, label) => {
  const bundle = join(root, label, 'holo-fixture')
  await mkdir(join(bundle, 'bin'), { recursive: true })
  await mkdir(join(bundle, 'private'))
  await writeFile(join(bundle, 'bin/holo'), 'binary fixture')
  await writeFile(join(bundle, 'private/host.json'), '{}')
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify(manifest))
  return bundle
}

test('archive membership rejects metadata, duplicates, omissions and traversal', () => {
  const expected = nativeArchiveMembers('holo-fixture', manifest)
  assert.doesNotThrow(() => verifyNativeArchiveMembers(expected, 'holo-fixture', manifest))
  for (
    const members of [
      [...expected, '._holo-fixture'],
      [...expected, 'holo-fixture/bin/._holo'],
      [...expected, 'holo-fixture/unmanifested'],
      [...expected, expected[0]],
      expected.slice(1)
    ]
  ) assert.throws(() => verifyNativeArchiveMembers(members, 'holo-fixture', manifest))
  for (const path of ['../outside', '/absolute', 'a\nb', 'a\\b']) {
    assert.throws(() => nativeArchiveMembers('holo-fixture', { files: { [path]: {} } }))
  }
})

test('extracted inventory refuses extra files, symlinks and hardlinks', async context => {
  const root = await mkdtemp(join(tmpdir(), 'holo-archive-inventory-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const bundle = await fixture(root, 'bundle')
  await verifyNativeBundleInventory({ bundle, manifest })
  const alias = join(root, 'aliased-bundle')
  await symlink(bundle, alias)
  await assert.rejects(verifyNativeBundleInventory({ bundle: alias, manifest }), /root must be a real directory/u)
  const extra = join(bundle, 'extra')
  await writeFile(extra, 'unexpected')
  await assert.rejects(verifyNativeBundleInventory({ bundle, manifest }), /extra/u)
  await rm(extra)
  await symlink(join(bundle, 'bin/holo'), extra)
  await assert.rejects(verifyNativeBundleInventory({ bundle, manifest }), /symlink/u)
  await rm(extra)
  await link(join(bundle, 'bin/holo'), extra)
  await assert.rejects(verifyNativeBundleInventory({ bundle, manifest }), /hardlinked/u)
})

test('Darwin archive strips xattrs and normalizes metadata to reproducible bytes', {
  skip: process.platform !== 'darwin'
}, async context => {
  const root = await mkdtemp(join(tmpdir(), 'holo-archive-stable-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const a = await fixture(root, 'a')
  const b = await fixture(root, 'b')
  await chmod(join(a, 'bin/holo'), 0o700)
  await chmod(join(b, 'bin/holo'), 0o500)
  await utimes(join(a, 'bin/holo'), 100, 100)
  await utimes(join(b, 'bin/holo'), 200, 200)
  const attr = spawnSync('/usr/bin/xattr', ['-w', 'com.holonomy.archive-test', 'not-for-delivery', join(a, 'bin/holo')])
  assert.equal(attr.status, 0, attr.stderr?.toString())
  const archiveA = join(root, 'a.tar.gz')
  const archiveB = join(root, 'b.tar.gz')
  await createNativeArchive({ bundle: a, manifest, archive: archiveA })
  await createNativeArchive({ bundle: b, manifest, archive: archiveB })
  const bytes = await readFile(archiveA)
  assert.deepEqual(bytes, await readFile(archiveB))
  assert.equal(bytes.readUInt32LE(4), 0, 'gzip timestamp must not vary')
  const header = gunzipSync(bytes).subarray(0, 512)
  assert.equal(Number.parseInt(header.subarray(108, 116).toString().replace(/\0/gu, '').trim(), 8), 0)
  assert.equal(Number.parseInt(header.subarray(116, 124).toString().replace(/\0/gu, '').trim(), 8), 0)
  assert.equal(header.subarray(265, 329).every(byte => byte === 0), true, 'do not embed local user/group names')
  const listed = spawnSync('/usr/bin/tar', ['-tzf', archiveA], { encoding: 'utf8' })
  assert.equal(listed.status, 0)
  verifyNativeArchiveMembers(listed.stdout.trimEnd().split('\n'), 'holo-fixture', manifest)
  assert.equal(listed.stdout.includes('._'), false)
})
