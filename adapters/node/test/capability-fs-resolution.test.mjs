import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { canonicalizeFilesystemResource } from '@holonomyjs/runtime/kernel'
import { NodeFilesystemPathsV1 } from '../src/capability-fs-paths.mjs'

test('resolves within-root symlinks and detects a changed target before execution', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'holonomy-fs-resolution-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  await mkdir(path.join(root, 'real'))
  await writeFile(path.join(root, 'real', 'first.txt'), 'first')
  await writeFile(path.join(root, 'real', 'second.txt'), 'second')
  await symlink(path.join(root, 'real', 'first.txt'), path.join(root, 'link.txt'))
  const paths = new NodeFilesystemPathsV1([{ hostPath: root, rootId: 'workspace' }])
  const resource = canonicalizeFilesystemResource('holo-fs://workspace/link.txt', 'link.txt')

  assert.throws(
    () => paths.resolution(resource, 'filesystem.file.read', 'deny'),
    error => error?.code === 'resource.cross_root'
  )
  const admitted = paths.resolution(resource, 'filesystem.file.read', 'withinRoot')
  assert.equal(admitted.resolved.virtualUrl, 'holo-fs://workspace/real/first.txt')
  await unlink(path.join(root, 'link.txt'))
  await symlink(path.join(root, 'real', 'second.txt'), path.join(root, 'link.txt'))
  const current = admitted.verify()
  assert.equal(current.resolved.virtualUrl, 'holo-fs://workspace/real/second.txt')
  assert.notEqual(current.resolved.semanticResourceDigest, admitted.resolved.semanticResourceDigest)
})
