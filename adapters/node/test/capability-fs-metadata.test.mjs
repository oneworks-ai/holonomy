import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- This test exercises real Host filesystem syscalls.
import test from 'node:test'

import { canonicalizeFilesystemResource } from '@holonomyjs/runtime/kernel'
import { NodeFilesystemPathsV1 } from '../src/capability-fs-paths.mjs'
import { NodeFilesystemProviderV1 } from '../src/capability-fs-provider.mjs'

const limits = {
  maxDirectoryEntries: 32,
  maxOpenHandles: 8,
  maxQueuedEvents: 8,
  maxReadBytes: 4096,
  maxWatchers: 2,
  maxWriteBytes: 4096
}
const authority = rights => ({
  bindings: [{
    providerModule: 'host.fs',
    constraints: {
      limits,
      roots: [{ rootId: 'workspace', pathPrefixSegments: [], rights, symlinks: 'deny' }]
    }
  }],
  complete: value => value
})
const context = (name, operation, args, selected, source) => {
  const requested = canonicalizeFilesystemResource(`holo-fs://workspace/${name}`, name)
  return {
    arguments: args,
    authorityBindings: selected.bindings,
    member: operation,
    module: 'node:fs/promises',
    operation,
    resource: { requested },
    runtime: { generation: 1 },
    source
  }
}
const execute = (provider, call, selected) => {
  const plan = provider.preflight(call, selected)
  assert.ok(plan)
  plan.requests[0].verify()
  return plan.execute(call, [selected])
}

test('metadata mutation, truncate, directory sync and access use pinned Host targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-fs-metadata-'))
  let provider
  try {
    fs.writeFileSync(path.join(root, 'file'), 'PRESERVED')
    fs.mkdirSync(path.join(root, 'folder'))
    provider = new NodeFilesystemProviderV1([{ rootId: 'workspace', hostPath: root }])
    const full = authority(['read', 'write', 'list'])
    const source = { kind: 'linuxProcess' }
    const chmodOnly = authority(['chmod'])
    const originalMode = fs.statSync(path.join(root, 'file')).mode
    assert.throws(
      () => execute(provider, context('file', 'filesystem.metadata.chmod', { mode: 0o744 }, full), full),
      { code: 'capability.denied' }
    )
    assert.equal(fs.statSync(path.join(root, 'file')).mode, originalMode)
    assert.throws(
      () => execute(provider, context('file', 'filesystem.metadata.chmod', { mode: 0o4755 }, chmodOnly), chmodOnly),
      { code: 'argument.invalid' }
    )
    const changed = execute(
      provider,
      context('file', 'filesystem.metadata.chmod', { mode: 0o744, readback: true }, chmodOnly, source),
      chmodOnly
    )
    assert.equal(changed.value.mode, fs.constants.S_IFREG | 0o744)
    assert.equal(changed.value.kind, 'file')
    assert.throws(
      () =>
        execute(
          provider,
          context('file', 'filesystem.file.truncate', { len: 1, expectedKind: 'file' }, full, source),
          full
        ),
      { code: 'argument.invalid' }
    )
    assert.equal(fs.readFileSync(path.join(root, 'file'), 'utf8'), 'PRESERVED')
    assert.throws(
      () =>
        execute(
          provider,
          {
            ...context(
              'file',
              'filesystem.metadata.chmod',
              { mode: 0o600, readback: true, expectedKind: 'directory' },
              chmodOnly,
              source
            )
          },
          chmodOnly
        ),
      { code: 'resource.invalid' }
    )
    assert.equal(fs.statSync(path.join(root, 'file')).mode & 0o777, 0o744)
    const readOnly = authority(['read'])
    const openCall = {
      ...context('file', 'filesystem.file.open', { flag: 'r', path: 'holo-fs://workspace/file' }, readOnly),
      member: 'open'
    }
    const fileHandle = execute(provider, openCall, readOnly)
    const fileBindingId = fileHandle.value.binding.bindingId
    const handleChmod = {
      ...openCall,
      arguments: { mode: 0o640, readback: true },
      member: 'FileHandle.chmod',
      operation: 'filesystem.metadata.chmod',
      resource: { requested: openCall.resource.requested, inheritedBindingId: fileBindingId },
      source
    }
    assert.throws(() => provider.invoke(handleChmod, readOnly), { code: 'capability.denied' })
    assert.throws(
      () =>
        provider.invoke({
          ...handleChmod,
          arguments: { mode: 0o600, readback: true, expectedKind: 'directory' }
        }, chmodOnly),
      { code: 'resource.invalid' }
    )
    assert.equal(fs.statSync(path.join(root, 'file')).mode & 0o777, 0o744)
    const handleChanged = provider.invoke(handleChmod, chmodOnly)
    assert.equal(handleChanged.value.mode, fs.constants.S_IFREG | 0o640)
    provider.invoke({ ...handleChmod, arguments: {}, operation: 'filesystem.file.close' }, readOnly)
    const now = { kind: 'set', seconds: 1_700_000_000, nanoseconds: 123_456_789 }
    const later = { kind: 'set', seconds: 1_700_000_001, nanoseconds: 987_654_321 }
    const dated = execute(
      provider,
      context('file', 'filesystem.metadata.utimes', { atime: now, mtime: later, readback: true }, full, source),
      full
    )
    assert.equal(dated.value.atimeNs, '1700000000123456789')
    assert.equal(dated.value.mtimeNs, '1700000001987654321')
    assert.equal(fs.statSync(path.join(root, 'file'), { bigint: true }).mtimeNs, 1_700_000_001_987_654_321n)
    assert.equal(fs.readFileSync(path.join(root, 'file'), 'utf8'), 'PRESERVED')
    const truncated = execute(
      provider,
      context('file', 'filesystem.file.truncate', { len: 4, readback: true }, full, source),
      full
    )
    assert.equal(truncated.value.size, 4)
    assert.equal(fs.readFileSync(path.join(root, 'file'), 'utf8'), 'PRES')
    fs.writeFileSync(path.join(root, 'folder', 'child'), 'entry')
    const directoryCall = context(
      'folder',
      'filesystem.directory.open',
      { path: 'holo-fs://workspace/folder' },
      full,
      source
    )
    const directory = execute(provider, directoryCall, full)
    assert.deepEqual(directory.value.entries.map(entry => entry.name), ['child'])
    const bindingId = directory.value.binding.bindingId
    fs.renameSync(path.join(root, 'folder'), path.join(root, 'held'))
    fs.mkdirSync(path.join(root, 'folder'))
    const originalIno = fs.statSync(path.join(root, 'held'), { bigint: true }).ino
    const replacementIno = fs.statSync(path.join(root, 'folder'), { bigint: true }).ino
    assert.notEqual(originalIno, replacementIno)
    const directoryChmod = {
      ...directoryCall,
      arguments: { mode: 0o700, readback: true },
      member: 'directory.chmod',
      operation: 'filesystem.metadata.chmod',
      resource: { requested: directoryCall.resource.requested, inheritedBindingId: bindingId }
    }
    assert.throws(() => provider.invoke(directoryChmod, full), { code: 'capability.denied' })
    assert.throws(
      () =>
        provider.invoke({
          ...directoryChmod,
          arguments: { mode: 0o777, readback: true, expectedKind: 'file' }
        }, chmodOnly),
      { code: 'resource.invalid' }
    )
    assert.notEqual(fs.statSync(path.join(root, 'held')).mode & 0o777, 0o777)
    const directoryChanged = provider.invoke(directoryChmod, chmodOnly)
    assert.equal(directoryChanged.value.mode, fs.constants.S_IFDIR | 0o700)
    assert.equal(fs.statSync(path.join(root, 'held')).mode & 0o777, 0o700)
    assert.notEqual(fs.statSync(path.join(root, 'folder')).mode & 0o777, 0o700)
    const syncCall = {
      ...directoryCall,
      arguments: { dataOnly: false },
      operation: 'filesystem.directory.sync',
      resource: { requested: directoryCall.resource.requested, inheritedBindingId: bindingId }
    }
    const originalFsync = fs.fsyncSync
    let syncedIno
    fs.fsyncSync = fd => {
      syncedIno = fs.fstatSync(fd, { bigint: true }).ino
      return originalFsync(fd)
    }
    try {
      provider.invoke(syncCall, full)
    } finally {
      fs.fsyncSync = originalFsync
    }
    assert.equal(syncedIno, originalIno)
    provider.invoke({ ...syncCall, operation: 'filesystem.directory.close', arguments: {} }, full)
    assert.throws(() => provider.invoke(syncCall, full), { code: 'resource.stale' })
    execute(provider, context('folder', 'filesystem.metadata.access', { mode: fs.constants.X_OK }, full), full)
    const listing = authority(['list'])
    execute(provider, context('folder', 'filesystem.metadata.access', { mode: fs.constants.R_OK }, listing), listing)
    assert.throws(
      () =>
        execute(provider, context('file', 'filesystem.metadata.access', { mode: fs.constants.R_OK }, listing), listing),
      { code: 'capability.denied' }
    )
    fs.chmodSync(path.join(root, 'file'), 0)
    try {
      execute(provider, context('file', 'filesystem.metadata.access', { mode: fs.constants.F_OK }, full), full)
      assert.throws(
        () => execute(provider, context('file', 'filesystem.metadata.access', { mode: fs.constants.R_OK }, full), full),
        { code: 'provider.permission_denied' }
      )
    } finally {
      fs.chmodSync(path.join(root, 'file'), 0o600)
    }
    fs.chmodSync(path.join(root, 'file'), 0o200)
    try {
      execute(provider, context('file', 'filesystem.metadata.access', { mode: fs.constants.W_OK }, full), full)
      execute(provider, context('file', 'filesystem.metadata.access', { mode: fs.constants.F_OK }, full), full)
      execute(
        provider,
        context('file', 'filesystem.metadata.utimes', { atime: now, mtime: later, readback: true }, full, source),
        full
      )
      assert.throws(
        () => execute(provider, context('file', 'filesystem.metadata.access', { mode: fs.constants.R_OK }, full), full),
        { code: 'provider.permission_denied' }
      )
    } finally {
      fs.chmodSync(path.join(root, 'file'), 0o600)
    }
    assert.throws(
      () => execute(provider, context('file', 'filesystem.metadata.access', { mode: fs.constants.X_OK }, full), full),
      { code: 'capability.denied' }
    )
    assert.throws(() => execute(provider, context('file', 'filesystem.file.truncate', { len: 4097 }, full), full), {
      code: 'resource.byte_limit'
    })
    assert.throws(
      () =>
        execute(
          provider,
          context('file', 'filesystem.metadata.utimes', { atime: { kind: 'now' }, mtime: later }, full),
          full
        ),
      { code: 'capability.denied' }
    )
  } finally {
    provider?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('canonical virtual names resolve to exact Host filenames', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-fs-names-'))
  let paths
  try {
    paths = new NodeFilesystemPathsV1([{ rootId: 'workspace', hostPath: root }])
    for (const name of ['a b.txt', '中文😀.txt', '%literal.txt', '%2F.txt', '.hidden']) {
      const virtualUrl = `holo-fs://workspace/${encodeURIComponent(name)}`
      fs.writeFileSync(path.join(root, name), `HOST:${name}`)
      const resource = canonicalizeFilesystemResource(virtualUrl, name)
      const resolution = paths.resolution(resource, 'filesystem.file.read', 'deny')
      assert.equal(resolution.evidence.targetType, 'file', name)
      assert.equal(resolution.resolved.virtualUrl, virtualUrl, name)
      assert.equal(paths.virtualPath('workspace', path.join(fs.realpathSync(root), name)), virtualUrl, name)
      const fd = paths.openPinned(resource, resolution.evidence, fs.constants.O_RDONLY)
      try {
        assert.equal(fs.readFileSync(fd, 'utf8'), `HOST:${name}`)
      } finally {
        fs.closeSync(fd)
      }
    }
    const safe = canonicalizeFilesystemResource('holo-fs://workspace/.hidden', 'safe')
    for (const part of ['%2F', '%5C', '%00', '%2E%2E', '%ZZ', '%ED%A0%80']) {
      assert.throws(
        () => paths.resolution({ ...safe, pathSegments: [part] }, 'filesystem.file.read', 'deny'),
        { code: 'resource.invalid' },
        part
      )
    }
  } finally {
    paths?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
