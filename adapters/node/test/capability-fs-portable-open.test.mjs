import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Real Node Provider primitive boundary.
import test from 'node:test'

import { canonicalizeFilesystemResource } from '@holonomyjs/runtime/kernel'

import { NodeFilesystemPathsV1 } from '../src/capability-fs-paths.mjs'
import { NodeFilesystemResourcesV1 } from '../src/capability-fs-resources.mjs'
import { flagRights, handleFlagRights, nodeOpenFlag, rightFor } from '../src/capability-fs-support.mjs'

const flag = (access, values = {}) => ({
  kind: 'portable-open-v1',
  access,
  create: false,
  exclusive: false,
  truncate: false,
  append: false,
  ...values
})

test('Node Provider opens portable Linux flags atomically and keeps handle rights exact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-portable-open-'))
  let paths
  try {
    const existing = join(root, 'existing.txt')
    const missing = join(root, 'missing.txt')
    await writeFile(existing, 'PRESERVED_CONTENT')
    paths = new NodeFilesystemPathsV1([{ rootId: 'workspace', hostPath: root }])
    const resources = new NodeFilesystemResourcesV1()
    const authority = { complete: (result, publications) => ({ result, publications }) }
    const resource = { rootId: 'workspace', semanticResourceDigest: 'test' }
    const open = (path, value) => {
      const name = basename(path)
      const requested = canonicalizeFilesystemResource(`holo-fs://workspace/${encodeURIComponent(name)}`, name)
      const resolved = paths.resolution(requested, 'filesystem.file.open', 'deny')
      return resources.open(
        {
          arguments: { flag: value },
          authorityBindings: [{ constraints: { limits: { maxOpenHandles: 8 } } }],
          member: 'open',
          module: 'node:fs/promises',
          operation: 'filesystem.file.open',
          runtime: { generation: 1 },
          source: { kind: 'linuxProcess' }
        },
        authority,
        resolved.resolved,
        resolved.evidence,
        flags => paths.openPinned(resolved.resolved, resolved.evidence, flags)
      )
    }

    const writeCreate = flag('write', { create: true })
    assert.deepEqual(flagRights(writeCreate), ['write'])
    const opened = open(existing, writeCreate)
    assert.equal(await readFile(existing, 'utf8'), 'PRESERVED_CONTENT')
    assert.deepEqual(handleFlagRights(writeCreate), ['write'])
    opened.publications[0].close()

    const readCreate = flag('read', { create: true })
    assert.deepEqual(flagRights(readCreate), ['read', 'write'])
    const created = open(missing, readCreate)
    assert.equal(await readFile(missing, 'utf8'), '')
    assert.deepEqual(handleFlagRights(readCreate), ['read'])
    assert.throws(() =>
      resources.invoke(
        {
          arguments: { data: 'NO_WRITE' },
          operation: 'filesystem.file.write',
          resource: { requested: resource }
        },
        authority,
        resource,
        created.result.value.binding.bindingId
      ), { code: 'capability.denied' })
    created.publications[0].close()

    assert.throws(() => open(join(root, 'absent.txt'), flag('write')), { code: 'resource.not_found' })
    assert.throws(() => open(existing, flag('write', { create: true, exclusive: true })), {
      code: 'resource.exists'
    })
    const truncating = open(existing, flag('write', { truncate: true }))
    truncating.publications[0].close()
    assert.equal(await readFile(existing, 'utf8'), '')
    await writeFile(existing, 'STRING_FLAG')
    const stringTruncating = open(existing, 'w')
    stringTruncating.publications[0].close()
    assert.equal(await readFile(existing, 'utf8'), '')
    assert.throws(() => open(join(root, 'absent.txt'), flag('write', { truncate: true })), {
      code: 'resource.not_found'
    })
    await writeFile(existing, 'PREFIX')
    const appending = open(existing, flag('write', { append: true }))
    resources.invoke(
      {
        arguments: { data: 'APPEND' },
        authorityBindings: [{ constraints: { limits: { maxWriteBytes: 1024 } } }],
        operation: 'filesystem.file.write',
        providerData: { kind: 'positionedWrite', offset: 0 },
        resource: { requested: resource }
      },
      authority,
      resource,
      appending.result.value.binding.bindingId
    )
    appending.publications[0].close()
    assert.equal(await readFile(existing, 'utf8'), 'PREFIXAPPEND')
    await writeFile(existing, 'OLD_CONTENT')
    const truncateAppend = open(existing, flag('write', { create: true, truncate: true, append: true }))
    assert.equal(await readFile(existing, 'utf8'), '')
    resources.invoke(
      {
        arguments: { data: 'NEW' },
        authorityBindings: [{ constraints: { limits: { maxWriteBytes: 1024 } } }],
        operation: 'filesystem.file.write',
        providerData: { kind: 'positionedWrite', offset: 0 },
        resource: { requested: resource }
      },
      authority,
      resource,
      truncateAppend.result.value.binding.bindingId
    )
    truncateAppend.publications[0].close()
    assert.equal(await readFile(existing, 'utf8'), 'NEW')
    assert.equal(nodeOpenFlag(flag('write', { create: true })) & nodeFs.constants.O_TRUNC, 0)
    assert.throws(() => nodeOpenFlag(flag('read', { append: true })), { code: 'argument.invalid' })
    assert.throws(() =>
      resources.open(
        {
          arguments: { flag: writeCreate },
          authorityBindings: [{ constraints: { limits: { maxOpenHandles: 8 } } }],
          operation: 'filesystem.file.open'
        },
        authority,
        resource,
        undefined,
        undefined
      ), { code: 'capability.denied' })
    assert.throws(() =>
      rightFor({
        operation: 'filesystem.file.open',
        arguments: { flag: writeCreate }
      }, resource), { code: 'capability.denied' })

    const requested = canonicalizeFilesystemResource('holo-fs://workspace/existing.txt', 'existing.txt')
    const resolved = paths.resolution(requested, 'filesystem.file.open', 'deny')
    let failedFd
    assert.throws(() =>
      resources.open(
        {
          arguments: { flag: 'r' },
          authorityBindings: [{ constraints: { limits: { maxOpenHandles: 8 } } }],
          member: 'open',
          module: 'node:fs/promises',
          operation: 'filesystem.file.open',
          runtime: { generation: 1 }
        },
        {
          complete: () => {
            throw new Error('publication failed')
          }
        },
        resolved.resolved,
        resolved.evidence,
        flags => {
          failedFd = paths.openPinned(resolved.resolved, resolved.evidence, flags)
          return failedFd
        }
      ), /publication failed/u)
    assert.throws(() => nodeFs.fstatSync(failedFd), { code: 'EBADF' })
  } finally {
    paths?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Node filesystem Provider root descriptors close with the generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-root-fd-close-'))
  const realRoot = nodeFs.realpathSync(root)
  const original = nodeFs.openSync
  let rootFd
  let paths
  try {
    nodeFs.openSync = (...args) => {
      const fd = original(...args)
      if (args[0] === realRoot) rootFd = fd
      return fd
    }
    paths = new NodeFilesystemPathsV1([{ rootId: 'workspace', hostPath: root }])
  } finally {
    nodeFs.openSync = original
  }
  try {
    assert.ok(Number.isInteger(rootFd))
    paths.close()
    assert.throws(() => nodeFs.fstatSync(rootFd), { code: 'EBADF' })
  } finally {
    paths?.close()
    await rm(root, { recursive: true, force: true })
  }
})
